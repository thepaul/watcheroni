import { DurableObject } from "cloudflare:workers";
import {
  ACCOUNT_REQUESTS_PER_MINUTE,
  INBOX_MAX_EVENTS,
  MAX_LIMIT,
  problem,
  type KeyInfo,
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
  keyId: string | null;
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

type KeyRow = {
  id: string;
  label: string | null;
  created_at: number;
  last_used_at: number | null;
};

// The account's request budget, for the RateLimit-* headers.
export interface RateState {
  limit: number;
  remaining: number;
  reset: number; // seconds until the bucket is full again
}

export type AuthResult =
  | { ok: true; keyId: string; rate: RateState }
  | { ok: false; reason: "unauthorized" }
  | { ok: false; reason: "rate_limited"; retryAfter: number; rate: RateState };

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
// last_used_at is only a hint for `GET /v1/keys`; writing it on every
// request would be a write per request.
const LAST_USED_GRANULARITY_MS = 60 * 60 * 1000;
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
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS keys (
        id TEXT PRIMARY KEY,
        hash BLOB NOT NULL,
        label TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS keys_hash ON keys (hash);
      CREATE TABLE IF NOT EXISTS ticket_nonces (nonce TEXT PRIMARY KEY, exp INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS buckets (name TEXT PRIMARY KEY, tokens REAL NOT NULL, updated_at INTEGER NOT NULL);
    `);
  }

  // RPC, at login: store a new key's hash. The Worker has already checked
  // the user's GitHub token and made the key; the key itself never gets here.
  createKey(id: string, hash: ArrayBuffer, label: string | null, login: string): KeyInfo {
    const now = Date.now();
    this.sql.exec("INSERT INTO meta (k, v) VALUES ('login', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", login);
    this.sql.exec("INSERT OR IGNORE INTO meta (k, v) VALUES ('created_at', ?)", String(now));
    this.sql.exec("INSERT INTO keys (id, hash, label, created_at) VALUES (?, ?, ?, ?)", id, hash, label, now);
    return keyInfo({ id, label, created_at: now, last_used_at: null });
  }

  // RPC, on every API request: is this a live key, and is there budget
  // left? The hash is of 32 random bytes, so looking it up with `=` leaks
  // nothing useful through timing.
  authenticate(hash: ArrayBuffer): AuthResult {
    const key = this.sql
      .exec<{ id: string; last_used_at: number | null }>(
        "SELECT id, last_used_at FROM keys WHERE hash = ? AND revoked_at IS NULL",
        hash,
      )
      .toArray()[0];
    if (!key) return { ok: false, reason: "unauthorized" };
    const now = Date.now();
    if (key.last_used_at === null || now - key.last_used_at >= LAST_USED_GRANULARITY_MS) {
      this.sql.exec("UPDATE keys SET last_used_at = ? WHERE id = ?", now, key.id);
    }
    const rate = this.take("requests", ACCOUNT_REQUESTS_PER_MINUTE, 60_000, now);
    if (rate.retryAfter) return { ok: false, reason: "rate_limited", retryAfter: rate.retryAfter, rate: rate.state };
    return { ok: true, keyId: key.id, rate: rate.state };
  }

  // RPC: live keys, oldest first.
  listKeys(): KeyInfo[] {
    return this.sql
      .exec<KeyRow>("SELECT id, label, created_at, last_used_at FROM keys WHERE revoked_at IS NULL ORDER BY id")
      .toArray()
      .map(keyInfo);
  }

  // RPC: revoke a key and hang up its WebSockets. False if there was no
  // such live key.
  revokeKey(id: string): boolean {
    const { rowsWritten } = this.sql.exec("UPDATE keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", Date.now(), id);
    for (const ws of this.ctx.getWebSockets(`key:${id}`)) ws.close(4001, "key revoked");
    return rowsWritten > 0;
  }

  // RPC: revoke every key, for when the user revokes the App's
  // authorization on GitHub (the github_app_authorization webhook).
  revokeAllKeys(): number {
    let n = 0;
    for (const { id } of this.listKeys()) if (this.revokeKey(id)) n++;
    return n;
  }

  private keyActive(id: string): boolean {
    return this.sql.exec("SELECT 1 FROM keys WHERE id = ? AND revoked_at IS NULL", id).toArray().length > 0;
  }

  // Remembers a ticket's nonce until the ticket expires. False if it was
  // already used.
  private useNonce(nonce: string, exp: number): boolean {
    const now = Math.floor(Date.now() / 1000);
    this.sql.exec("DELETE FROM ticket_nonces WHERE exp <= ?", now);
    const { rowsWritten } = this.sql.exec("INSERT OR IGNORE INTO ticket_nonces (nonce, exp) VALUES (?, ?)", nonce, exp);
    return rowsWritten > 0;
  }

  // A token bucket holding `capacity` tokens, refilled at `capacity` per
  // `periodMs` (DESIGN.md, "Limits"). Takes one token if there is one.
  private take(name: string, capacity: number, periodMs: number, now: number): { state: RateState; retryAfter: number } {
    const row = this.sql
      .exec<{ tokens: number; updated_at: number }>("SELECT tokens, updated_at FROM buckets WHERE name = ?", name)
      .toArray()[0];
    const perMs = capacity / periodMs;
    let tokens = row ? Math.min(capacity, row.tokens + (now - row.updated_at) * perMs) : capacity;
    let retryAfter = 0;
    if (tokens >= 1) tokens -= 1;
    else retryAfter = Math.ceil((1 - tokens) / perMs / 1000);
    this.sql.exec(
      "INSERT INTO buckets (name, tokens, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at",
      name, tokens, now,
    );
    const state = { limit: capacity, remaining: Math.floor(tokens), reset: Math.ceil((capacity - tokens) / perMs / 1000) };
    return { state, retryAfter };
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

  // WebSocket upgrades only. The Worker has already checked the caller's
  // key or the ticket's signature and expiry, and the inbox name. A client
  // socket names its key, and a ticket's nonce and expiry; this checks the
  // key is still live and the ticket hasn't been used.
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const url = new URL(request.url);
    const name = url.searchParams.get("inbox") ?? "";
    const mode = url.searchParams.get("mode") === "bridge" ? "bridge" : "client";
    const keyId = url.searchParams.get("key");
    if (mode === "client") {
      const nonce = url.searchParams.get("nonce");
      if (!keyId || !this.keyActive(keyId)) return problem(401, "unauthorized", "Key revoked");
      if (nonce && !this.useNonce(nonce, Number(url.searchParams.get("exp")))) {
        return problem(401, "unauthorized", "Ticket already used");
      }
    }
    this.ensureInbox(name);

    const { 0: client, 1: server } = new WebSocketPair();
    // A bridge says where it is reading from up front; a client says so in
    // its `hello`.
    const after = mode === "bridge" ? Number(url.searchParams.get("after") ?? "0") : null;
    const attachment: Attachment = { inbox: name, mode, keyId, pos: after, connectedAt: Date.now() };
    const tags = [`inbox:${name}`, `mode:${mode}`];
    if (keyId) tags.push(`key:${keyId}`);
    this.ctx.acceptWebSocket(server, tags);
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

function keyInfo(row: KeyRow): KeyInfo {
  return {
    id: row.id,
    label: row.label,
    created_at: new Date(row.created_at).toISOString(),
    last_used_at: row.last_used_at === null ? null : new Date(row.last_used_at).toISOString(),
  };
}

function send(ws: WebSocket, msg: ServerMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // The socket closed under us; its close handler will run.
  }
}
