import { DurableObject } from "cloudflare:workers";
import {
  INBOX_MAX_EVENTS,
  MAX_LIMIT,
  type ClientMessage,
  type EventsPage,
  type ServerMessage,
  type UnsequencedEvent,
  type WatchEvent,
} from "./protocol";

// What each WebSocket remembers across hibernation. `pos` is the last seq
// sent down this socket; null means a client socket that hasn't sent
// `hello` yet, so nothing is pushed to it.
interface Attachment {
  inbox: string;
  mode: "client" | "bridge";
  pos: number | null;
  connectedAt: number;
}

// A type alias, not an interface, so it satisfies SqlStorage's row constraint.
type InboxRow = {
  name: string;
  created_at: number;
  last_read_at: number | null;
  head: number;
  acked: number;
};

export interface Delivery {
  inbox: string;
  event: UnsequencedEvent;
}

export interface AccountStats {
  instance: string;
  startedAt: string;
  // Each time this object was constructed: the first time, and every time
  // it woke from hibernation or eviction. A new entry while sockets stayed
  // open is the evidence that it hibernated.
  wakes: { instance: string; at: string }[];
  sockets: { inbox: string; mode: string; pos: number | null; connectedAt: string }[];
  inboxes: InboxRow[];
}

const WAKES_KEPT = 200;
const SUBPROTOCOL = "watcheroni.v1";

export class Account extends DurableObject<Env> {
  private readonly instance = crypto.randomUUID();
  private readonly startedAt = Date.now();
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.migrate();
    this.sql.exec("INSERT INTO wakes (instance, at) VALUES (?, ?)", this.instance, this.startedAt);
    this.sql.exec(
      "DELETE FROM wakes WHERE rowid NOT IN (SELECT rowid FROM wakes ORDER BY at DESC LIMIT ?)",
      WAKES_KEPT,
    );
    // Keepalives are answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS inboxes (
        name TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        last_read_at INTEGER,
        head INTEGER NOT NULL DEFAULT 0,
        acked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS events (
        inbox TEXT NOT NULL,
        seq INTEGER NOT NULL,
        id TEXT NOT NULL,
        body TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (inbox, seq)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS events_dedupe ON events (inbox, id);
      CREATE TABLE IF NOT EXISTS wakes (instance TEXT NOT NULL, at INTEGER NOT NULL);
    `);
  }

  // RPC: create the inbox if needed.
  ensureInbox(name: string): InboxRow {
    this.sql.exec("INSERT OR IGNORE INTO inboxes (name, created_at) VALUES (?, ?)", name, Date.now());
    return this.inbox(name)!;
  }

  // RPC: one page of events after `after` (or after `acked` when null).
  // Returns null if the inbox doesn't exist.
  readEvents(name: string, after: number | null, limit: number): EventsPage | null {
    const inbox = this.inbox(name);
    if (!inbox) return null;
    this.sql.exec("UPDATE inboxes SET last_read_at = ? WHERE name = ?", Date.now(), name);
    const from = after ?? inbox.acked;
    const events = this.eventsAfter(name, from, limit);
    return {
      events,
      next: events.length ? events[events.length - 1].seq : from,
      head: inbox.head,
      acked: inbox.acked,
    };
  }

  // RPC: move the acknowledged position forward, never back or past head.
  ack(name: string, seq: number): InboxRow | null {
    this.sql.exec("UPDATE inboxes SET acked = MAX(acked, MIN(?, head)) WHERE name = ?", seq, name);
    return this.inbox(name);
  }

  // RPC: append events to inboxes and push them to waiting sockets. In the
  // full design RepoHub calls this; in the prototype /debug does.
  deliver(items: Delivery[]): { delivered: number; duplicates: number } {
    let delivered = 0;
    let duplicates = 0;
    const touched = new Set<string>();
    for (const { inbox: name, event } of items) {
      const inbox = this.ensureInbox(name);
      const seen = this.sql.exec("SELECT 1 FROM events WHERE inbox = ? AND id = ?", name, event.id).toArray();
      if (seen.length) {
        duplicates++;
        continue;
      }
      const seq = inbox.head + 1;
      const body: WatchEvent = { ...event, seq };
      this.sql.exec(
        "INSERT INTO events (inbox, seq, id, body, at) VALUES (?, ?, ?, ?, ?)",
        name, seq, event.id, JSON.stringify(body), Date.now(),
      );
      this.sql.exec("UPDATE inboxes SET head = ? WHERE name = ?", seq, name);
      this.sql.exec("DELETE FROM events WHERE inbox = ? AND seq <= ?", name, seq - INBOX_MAX_EVENTS);
      touched.add(name);
      delivered++;
    }
    for (const name of touched) this.push(name);
    return { delivered, duplicates };
  }

  // RPC: what the hibernation test looks at.
  stats(): AccountStats {
    const wakes = this.sql
      .exec<{ instance: string; at: number }>("SELECT instance, at FROM wakes ORDER BY at DESC LIMIT 50")
      .toArray()
      .map((w) => ({ instance: w.instance, at: new Date(w.at).toISOString() }));
    const sockets = this.ctx.getWebSockets().map((ws) => {
      const a = ws.deserializeAttachment() as Attachment;
      return { inbox: a.inbox, mode: a.mode, pos: a.pos, connectedAt: new Date(a.connectedAt).toISOString() };
    });
    const inboxes = this.sql.exec<InboxRow>("SELECT * FROM inboxes ORDER BY name").toArray();
    return { instance: this.instance, startedAt: new Date(this.startedAt).toISOString(), wakes, sockets, inboxes };
  }

  // WebSocket upgrades only. The Worker has already authenticated the
  // caller and checked the inbox name.
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const url = new URL(request.url);
    const name = url.searchParams.get("inbox") ?? "";
    const mode = url.searchParams.get("mode") === "bridge" ? "bridge" : "client";
    this.ensureInbox(name);

    const { 0: client, 1: server } = new WebSocketPair();
    // A bridge says where it is reading from up front; a client says so in
    // its `hello`.
    const after = mode === "bridge" ? Number(url.searchParams.get("after") ?? "0") : null;
    const attachment: Attachment = { inbox: name, mode, pos: after, connectedAt: Date.now() };
    this.ctx.acceptWebSocket(server, [`inbox:${name}`, `mode:${mode}`]);
    server.serializeAttachment(attachment);
    // An event may have arrived between the Worker's first read and this
    // connection; send it now rather than wait for the next one.
    if (mode === "bridge") this.sendFrom(server, attachment, 1);
    // A client that asks for a subprotocol fails the handshake unless the
    // server picks one.
    const offered = request.headers.get("Sec-WebSocket-Protocol")?.split(",").map((p) => p.trim()) ?? [];
    const responseHeaders: HeadersInit = offered.includes(SUBPROTOCOL) ? { "Sec-WebSocket-Protocol": SUBPROTOCOL } : {};
    return new Response(null, { status: 101, webSocket: client, headers: responseHeaders });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      return send(ws, { type: "error", code: "invalid_request", detail: "messages must be JSON" });
    }
    switch (msg.type) {
      case "hello": {
        const inbox = this.inbox(attachment.inbox);
        if (!inbox) return ws.close(4004, "inbox deleted");
        attachment.pos = typeof msg.after === "number" ? msg.after : inbox.acked;
        ws.serializeAttachment(attachment);
        send(ws, { type: "ready", inbox: inbox.name, head: inbox.head, acked: inbox.acked });
        this.sendFrom(ws, attachment);
        return;
      }
      case "ack":
        this.ack(attachment.inbox, msg.seq);
        return;
      default:
        return send(ws, { type: "error", code: "invalid_request", detail: "unknown message type" });
    }
  }

  override async webSocketClose(): Promise<void> {
    // Since compatibility date 2026-04-07 the runtime completes the close
    // handshake itself; nothing else to clean up.
  }

  private push(name: string): void {
    for (const ws of this.ctx.getWebSockets(`inbox:${name}`)) {
      const attachment = ws.deserializeAttachment() as Attachment;
      if (attachment.pos === null) continue;
      // A bridge needs only one batch: the Worker answers and hangs up.
      this.sendFrom(ws, attachment, attachment.mode === "bridge" ? 1 : Infinity);
    }
  }

  // Send everything after the socket's position, in pages.
  private sendFrom(ws: WebSocket, attachment: Attachment, maxPages = Infinity): void {
    for (let page = 0; page < maxPages && attachment.pos !== null; page++) {
      const events = this.eventsAfter(attachment.inbox, attachment.pos, MAX_LIMIT);
      if (!events.length) return;
      send(ws, { type: "events", events });
      attachment.pos = events[events.length - 1].seq;
      ws.serializeAttachment(attachment);
    }
  }

  private inbox(name: string): InboxRow | null {
    return this.sql.exec<InboxRow>("SELECT * FROM inboxes WHERE name = ?", name).toArray()[0] ?? null;
  }

  private eventsAfter(name: string, after: number, limit: number): WatchEvent[] {
    return this.sql
      .exec<{ body: string }>(
        "SELECT body FROM events WHERE inbox = ? AND seq > ? ORDER BY seq LIMIT ?",
        name, after, limit,
      )
      .toArray()
      .map((row) => JSON.parse(row.body) as WatchEvent);
  }
}

function send(ws: WebSocket, msg: ServerMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // The socket closed under us; its close handler will run.
  }
}
