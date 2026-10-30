import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { ClientMessage, ServerMessage, WatchEvent } from "@watcheroni/protocol";

// A small stand-in for a watcheroni server: inboxes, long-polling, ack,
// subscriptions, the refresh proxy, and the WebSocket protocol, with
// WebSocket framing done by hand so the tests need no WebSocket library.

interface FakeInbox {
  head: number;
  acked: number;
  events: WatchEvent[];
}

class FakeSocket {
  pos: number | null = null;
  readonly socket: Socket;
  readonly inbox: string;
  private readonly server: FakeServer;
  private buffer = Buffer.alloc(0);

  constructor(socket: Socket, inbox: string, server: FakeServer) {
    this.socket = socket;
    this.inbox = inbox;
    this.server = server;
    socket.on("data", (chunk) => this.read(chunk));
    socket.on("close", () => server.sockets.delete(this));
    socket.on("error", () => {});
  }

  send(msg: ServerMessage | string): void {
    this.frame(0x1, Buffer.from(typeof msg === "string" ? msg : JSON.stringify(msg)));
  }

  close(code: number, reason = ""): void {
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code);
    body.write(reason, 2);
    this.frame(0x8, body);
    this.socket.end();
  }

  private frame(opcode: number, payload: Buffer): void {
    const len = payload.length;
    const head = len < 126 ? Buffer.from([0x80 | opcode, len])
      : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 0xff])
      : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 127; b.writeBigUInt64BE(BigInt(len), 2); return b; })();
    if (!this.socket.destroyed) this.socket.write(Buffer.concat([head, payload]));
  }

  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const opcode = this.buffer[0] & 0x0f;
      let len = this.buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      // Client frames are always masked.
      if (this.buffer.length < offset + 4 + len) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      this.buffer = this.buffer.subarray(offset + 4 + len);
      if (opcode === 0x8) {
        this.close(payload.length >= 2 ? payload.readUInt16BE(0) : 1000);
        return;
      }
      if (opcode === 0x1) this.server.onMessage(this, payload.toString());
    }
  }
}

export class FakeServer {
  readonly token = "test-token";
  readonly inboxes = new Map<string, FakeInbox>();
  readonly sockets = new Set<FakeSocket>();
  readonly requests: string[] = [];
  readonly messages: string[] = [];
  // Refuse WebSocket upgrades, as a proxy might.
  refuseSockets = false;
  // Repos the App is installed on, and whether each is private.
  readonly repos = new Map<string, { private: boolean }>();
  // Where an app_not_installed answer says to install it.
  installUrl: unknown = "https://github.com/apps/watcheroni/installations/new";
  // GitHub tokens accepted for private repos.
  readonly githubTokens = new Set<string>();
  // Subscriptions made, with the X-GitHub-Token each request carried.
  readonly subscriptions: {
    id: string; inbox: string; repo: string; pr: number | null; githubToken: string | null;
    kinds?: string[]; base?: string; author?: string;
  }[] = [];
  // Subscription IDs deleted.
  readonly deleted: string[] = [];
  // Private subscriptions' verified_until, by ID, and the verify calls seen.
  readonly verifiedUntil = new Map<string, string>();
  readonly verified: { id: string; githubToken: string | null }[] = [];
  // What POST /v1/github/refresh answers, and the refresh tokens it saw.
  refreshAnswer: Record<string, unknown> = { error: "bad_refresh_token" };
  readonly refreshed: string[] = [];
  private http: Server | null = null;
  private waiting = new Set<() => void>();
  port = 0;

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(port = 0): Promise<this> {
    this.http = createServer((req, res) => void this.handle(req, res));
    this.http.on("upgrade", (req, socket: Socket) => this.upgrade(req, socket));
    await new Promise<void>((r) => this.http!.listen(port, "127.0.0.1", r));
    this.port = (this.http.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.socket.destroy();
    for (const w of this.waiting) w();
    this.http?.closeAllConnections();
    await new Promise<void>((r) => this.http?.close(() => r()) ?? r());
  }

  inbox(name: string): FakeInbox {
    let inbox = this.inboxes.get(name);
    if (!inbox) this.inboxes.set(name, (inbox = { head: 0, acked: 0, events: [] }));
    return inbox;
  }

  inject(
    name: string, kind = "debug.ping", data: WatchEvent["data"] = {}, id = `fake:${Math.random()}`, sub: string | null = null,
    pr: number | null = 7,
  ): WatchEvent {
    const inbox = this.inbox(name);
    const event: WatchEvent = {
      v: 1, seq: ++inbox.head, id, sub, kind, at: "t", received_at: "t",
      repo: { id: 1, full_name: "octo/widgets" }, pr, actor: null, data, links: {},
    };
    inbox.events.push(event);
    for (const s of this.sockets) if (s.inbox === name && s.pos !== null) this.sendFrom(s);
    for (const w of [...this.waiting]) w();
    return event;
  }

  closeSockets(code: number, reason = ""): void {
    for (const s of this.sockets) s.close(code, reason);
  }

  onMessage(s: FakeSocket, text: string): void {
    this.messages.push(text);
    if (text === "ping") return s.send("pong");
    const msg = JSON.parse(text) as ClientMessage;
    const inbox = this.inbox(s.inbox);
    if (msg.type === "hello") {
      s.pos = msg.after ?? inbox.acked;
      s.send({ type: "ready", inbox: s.inbox, head: inbox.head, acked: inbox.acked });
      this.sendFrom(s);
    } else if (msg.type === "ack") {
      inbox.acked = Math.max(inbox.acked, Math.min(msg.seq, inbox.head));
    }
  }

  private sendFrom(s: FakeSocket): void {
    const events = this.inbox(s.inbox).events.filter((e) => e.seq > s.pos!);
    if (!events.length) return;
    s.send({ type: "events", events });
    s.pos = events[events.length - 1].seq;
  }

  private authorized(req: IncomingMessage): boolean {
    return req.headers.authorization === `Bearer ${this.token}`;
  }

  private upgrade(req: IncomingMessage, socket: Socket): void {
    this.requests.push(`UPGRADE ${req.url}`);
    const m = req.url?.match(/^\/v1\/inboxes\/([^/?]+)\/ws/);
    if (this.refuseSockets || !m) {
      socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (!this.authorized(req)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    const offered = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      ...(offered.includes("watcheroni.v1") ? ["Sec-WebSocket-Protocol: watcheroni.v1"] : []),
      "", "",
    ].join("\r\n"));
    this.sockets.add(new FakeSocket(socket, decodeURIComponent(m[1]), this));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url!, this.url);
    this.requests.push(`${req.method} ${url.pathname}${url.search}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": status < 400 ? "application/json" : "application/problem+json" });
      res.end(JSON.stringify(body));
    };
    const readBody = async <T>() => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      return JSON.parse(Buffer.concat(chunks).toString()) as T;
    };
    if (req.method === "POST" && url.pathname === "/v1/github/refresh") {
      this.refreshed.push((await readBody<{ refresh_token: string }>()).refresh_token);
      return json(200, this.refreshAnswer);
    }
    if (!this.authorized(req)) return json(401, { status: 401, code: "unauthorized" });
    const m = url.pathname.match(/^\/v1\/inboxes\/([^/]+)(\/[a-z]+)?(?:\/([^/]+)(\/[a-z]+)?)?$/);
    if (!m) return json(404, { status: 404, code: "not_found" });
    const name = decodeURIComponent(m[1]);
    const route = `${req.method} ${m[2] ?? ""}${m[3] ? `/{id}${m[4] ?? ""}` : ""}`;
    const inbox = this.inbox(name);
    if (route === "PUT ") return json(200, { name, head: inbox.head, acked: inbox.acked });
    if (route === "POST /subscriptions") {
      const body = await readBody<{ repo: string; pr?: number; kinds?: string[]; base?: string; author?: string }>();
      const repo = this.repos.get(body.repo);
      if (!repo) {
        return json(409, { status: 409, code: "app_not_installed", install_url: this.installUrl });
      }
      const githubToken = (req.headers["x-github-token"] as string | undefined) ?? null;
      if (repo.private && !githubToken) return json(401, { status: 401, code: "github_token_required" });
      if (repo.private && !this.githubTokens.has(githubToken!)) return json(401, { status: 401, code: "github_token_invalid" });
      const id = `sub_${this.subscriptions.length + 1}`;
      const { kinds, base, author } = body;
      this.subscriptions.push({ id, inbox: name, repo: body.repo, pr: body.pr ?? null, githubToken, kinds, base, author });
      return json(201, { id, inbox: name, repo: { id: 1, full_name: body.repo, private: repo.private }, pr: body.pr ?? null, kinds, base, author });
    }
    if (route === "DELETE /subscriptions/{id}") {
      this.deleted.push(m[3]);
      res.writeHead(204).end();
      return;
    }
    if (route === "GET /subscriptions") {
      const subscriptions = this.subscriptions.filter((s) => s.inbox === name).map((s) => ({
        id: s.id, inbox: name, pr: s.pr,
        repo: { id: 1, full_name: s.repo, private: !!this.repos.get(s.repo)?.private },
        verified_until: this.verifiedUntil.get(s.id) ?? null,
      }));
      return json(200, { subscriptions });
    }
    if (route === "POST /subscriptions/{id}/verify") {
      const githubToken = (req.headers["x-github-token"] as string | undefined) ?? null;
      this.verified.push({ id: m[3], githubToken });
      if (!githubToken || !this.githubTokens.has(githubToken)) return json(401, { status: 401, code: "github_token_invalid" });
      this.verifiedUntil.set(m[3], new Date(Date.now() + 7 * 24 * 3600_000).toISOString());
      return json(200, {});
    }
    if (route === "POST /ack") {
      const { seq } = await readBody<{ seq: number }>();
      inbox.acked = Math.max(inbox.acked, Math.min(seq, inbox.head));
      return json(200, { name, head: inbox.head, acked: inbox.acked });
    }
    if (route === "GET /events") {
      const after = url.searchParams.has("after") ? Number(url.searchParams.get("after")) : inbox.acked;
      const wait = Number(url.searchParams.get("wait") ?? 0);
      const page = () => {
        const events = inbox.events.filter((e) => e.seq > after);
        return { events, next: events.length ? events[events.length - 1].seq : after, head: inbox.head, acked: inbox.acked };
      };
      if (!page().events.length && wait > 0) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            this.waiting.delete(done);
            resolve();
          };
          const timer = setTimeout(done, wait * 1000);
          this.waiting.add(done);
          res.on("close", done);
        });
      }
      if (!res.destroyed) json(200, page());
      return;
    }
    json(404, { status: 404, code: "not_found" });
  }
}
