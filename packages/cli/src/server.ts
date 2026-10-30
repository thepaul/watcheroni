import type { EventsPage, ServerMessage, SubscriptionInfo, SubscriptionRequest, SubscriptionsResponse, WatchEvent } from "@watcheroni/protocol";
import pkg from "../package.json" with { type: "json" };
import type { ServerConfig } from "./config.ts";
import { LoginNeeded } from "./github.ts";
import { anyKey, isPr, type RepoTarget, type Target } from "./targets.ts";

// Server mode: reading an inbox on a watcheroni server (PROTOCOL.md,
// "Reading events"), over a WebSocket, or by long-polling when a socket
// can't be opened.

// The server can't be reached, or answered 5xx or 429. Worth retrying.
// `code` and `retryAfter` (seconds) are the server's, when it answered.
export class Unreachable extends Error {
  readonly code: string | null;
  readonly retryAfter: number | null;
  constructor(message: string, o: { code?: string; retryAfter?: number | null } = {}) {
    super(message);
    this.code = o.code ?? null;
    this.retryAfter = o.retryAfter ?? null;
  }
}

// A long poll refused because too many are already waiting on the account
// is asked again this often, unless the server says otherwise.
const CROWDED_RETRY_SECONDS = 30;

// Any other error the server answered with. Not worth retrying.
export class ServerError extends Error {
  readonly status: number;
  readonly code: string;
  // The whole problem document, for fields such as `install_url`.
  readonly problem: Record<string, unknown>;
  constructor(message: string, status: number, code: string, problem: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.problem = problem;
  }
}

// 401s that are about the GitHub token sent with a request, not the API key.
const GITHUB_TOKEN_CODES = new Set(["github_token_required", "github_token_invalid"]);

const SUBPROTOCOL = "watcheroni.v1";
const WAIT_SECONDS = 300;

export class ServerClient {
  readonly url: string;
  private readonly apiKey: string;

  constructor(config: ServerConfig) {
    this.url = config.url;
    this.apiKey = config.apiKey;
  }

  async request<T>(
    method: string,
    path: string,
    o: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    const timeout = AbortSignal.timeout(o.timeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await fetch(this.url + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "user-agent": `watcheroni-cli/${pkg.version}`,
          ...(o.body === undefined ? {} : { "content-type": "application/json" }),
          ...o.headers,
        },
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout,
      });
    } catch (e) {
      if (o.signal?.aborted) throw e;
      const cause = (e as Error & { cause?: Error }).cause;
      throw new Unreachable(`can't reach ${this.url}: ${cause?.message ?? (e as Error).message}`);
    }
    if (res.status === 204) return undefined as T;
    if (res.ok) return (await res.json()) as T;
    const problem = (await res.json().catch(() => ({}))) as { code?: string; title?: string; detail?: string };
    const code = problem.code ?? String(res.status);
    if (res.status === 401 && !GITHUB_TOKEN_CODES.has(code)) {
      throw new LoginNeeded(`${this.url} rejected the API key (${code}); check WATCHERONI_API_KEY`);
    }
    if (res.status >= 500 || res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After"));
      throw new Unreachable(`${this.url} answered ${res.status} (${code}${problem.title ? `: ${problem.title}` : ""})`, {
        code,
        retryAfter: retryAfter > 0 ? retryAfter : null,
      });
    }
    throw new ServerError(`${this.url}: ${method} ${path}: ${res.status} ${problem.detail ?? problem.title ?? code}`, res.status, code, problem);
  }

  ensureInbox(name: string): Promise<{ head: number; acked: number }> {
    return this.request("PUT", `/v1/inboxes/${name}`);
  }

  events(name: string, after: number | null, wait: number, signal?: AbortSignal): Promise<EventsPage> {
    const query = new URLSearchParams({ wait: String(wait) });
    if (after !== null) query.set("after", String(after));
    return this.request("GET", `/v1/inboxes/${name}/events?${query}`, { signal, timeoutMs: (wait + 30) * 1000 });
  }

  ack(name: string, seq: number): Promise<unknown> {
    return this.request("POST", `/v1/inboxes/${name}/ack`, { body: { seq } });
  }

  // Where and how to open the inbox's WebSocket. The API key goes in the
  // handshake's Authorization header, which the protocol allows for
  // clients that can set headers. If that ever has to change, this is
  // where to get a one-use ticket from POST /v1/inboxes/{name}/ticket and
  // connect to the URL it returns instead.
  async socket(name: string): Promise<{ url: string; headers: Record<string, string> }> {
    const url = new URL(`${this.url}/v1/inboxes/${name}/ws`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return { url: url.href, headers: { Authorization: `Bearer ${this.apiKey}` } };
  }
}

export interface SubscribeOptions {
  log: (msg: string) => void;
  // The user's GitHub token for this server (from `watcheroni login`),
  // refreshed if it has expired, or null if there isn't one.
  githubToken?: () => Promise<string | null>;
}

// Subscribes the inbox to a PR, or a whole repository, on the server
// (PROTOCOL.md, "Subscriptions") and returns the subscription's ID. Asks
// without a GitHub token first; only a private repo needs one, and it's
// sent only then. Returns null when the server won't watch it (the App
// isn't installed, no access, unreachable), so a PR is polled from this
// machine instead.
export async function subscribe(client: ServerClient, inbox: string, target: Target | RepoTarget, o: SubscribeOptions): Promise<string | null> {
  const repo = `${target.owner}/${target.name}`;
  const path = `/v1/inboxes/${inbox}/subscriptions`;
  const body: SubscriptionRequest = isPr(target)
    ? { repo, pr: target.number }
    : { repo, kinds: target.kinds, ...(target.base ? { base: target.base } : {}), ...(target.author ? { author: target.author } : {}) };
  try {
    try {
      return (await client.request<SubscriptionInfo>("POST", path, { body })).id;
    } catch (e) {
      if (!(e instanceof ServerError && e.code === "github_token_required")) throw e;
      const token = await o.githubToken?.();
      if (!token) {
        o.log(`${repo} is private and there's no GitHub token for ${client.url} on this machine; run \`watcheroni login\` to have the server watch it`);
        return null;
      }
      return (await client.request<SubscriptionInfo>("POST", path, { body, headers: { "X-GitHub-Token": token } })).id;
    }
  } catch (e) {
    if (e instanceof ServerError) {
      if (e.code === "app_not_installed") {
        const url = typeof e.problem.install_url === "string" ? `; it can be installed from ${e.problem.install_url}` : "";
        o.log(`the watcheroni App isn't installed on ${repo}${url}`);
      } else if (e.code === "github_token_invalid") {
        o.log(`${client.url} didn't accept this machine's GitHub token for ${repo}; run \`watcheroni login\` again`);
      } else {
        o.log(`${client.url} won't watch ${anyKey(target)}: ${e.problem.detail ?? e.problem.title ?? e.code}`);
      }
      return null;
    }
    if (e instanceof Unreachable) {
      o.log(`couldn't subscribe to ${anyKey(target)} (${e.message})`);
      return null;
    }
    throw e;
  }
}

// How long before `verified_until` a private subscription is renewed, and
// how often a long-running command checks.
export const RENEW_BEFORE_MS = 2 * 24 * 3600_000;
export const RENEW_EVERY_MS = 6 * 3600_000;

// A private repo's subscription must show a fresh GitHub token before its
// `verified_until` (PROTOCOL.md, "Private repositories stay verified"), or
// the server ends it. Renews the inbox's subscriptions that are due soon.
// Problems are logged, never thrown: the next check tries again.
export async function renewSubscriptions(client: ServerClient, inbox: string, o: SubscribeOptions, now = Date.now()): Promise<void> {
  let subs: SubscriptionInfo[];
  try {
    subs = (await client.request<SubscriptionsResponse>("GET", `/v1/inboxes/${inbox}/subscriptions`)).subscriptions;
  } catch (e) {
    if (e instanceof ServerError || e instanceof Unreachable || e instanceof LoginNeeded) return;
    throw e;
  }
  const due = subs.filter((s) => s.repo.private && s.verified_until && Date.parse(s.verified_until) - now < RENEW_BEFORE_MS);
  if (!due.length) return;
  const token = await o.githubToken?.();
  if (!token) {
    o.log(`the server needs a fresh GitHub token to keep watching ${due.map((s) => s.repo.full_name).join(", ")}; run \`watcheroni login\``);
    return;
  }
  for (const s of due) {
    try {
      await client.request("POST", `/v1/inboxes/${inbox}/subscriptions/${s.id}/verify`, { headers: { "X-GitHub-Token": token } });
    } catch (e) {
      if (e instanceof ServerError) {
        o.log(e.code === "repo_access_denied"
          ? `you can no longer read ${s.repo.full_name}, so the server has stopped watching it`
          : `couldn't renew the server's watch on ${s.repo.full_name}: ${e.problem.detail ?? e.problem.title ?? e.code}`);
        continue;
      }
      if (e instanceof Unreachable || e instanceof LoginNeeded) return;
      throw e;
    }
  }
}

export interface ReaderOptions {
  log: (msg: string) => void;
  // Reconnect delays: the first, and the most (PROTOCOL.md: 1 s doubling to 60 s).
  backoff?: [number, number];
  pingMs?: number;
  connectTimeoutMs?: number;
}

// Reads one server inbox in the background, keeping the events not yet
// acknowledged. Connects over a WebSocket, sending `hello` with the last
// seq received; if no socket can be opened while plain HTTP works, it
// long-polls instead. Reconnects with backoff until closed, unless the
// server says to stop (a rejected key, a deleted inbox).
export class ServerReader {
  readonly client: ServerClient;
  readonly name: string;
  // True while connected and reading.
  connected = false;
  // Set when reading has stopped for good; the next wait throws it.
  failure: Error | null = null;

  private pos: number | null = null;
  private queue: WatchEvent[] = [];
  private seen = new Set<string>();
  private fresh = false;
  private waiters = new Set<() => void>();
  private ws: WebSocket | null = null;
  private mode: "ws" | "longpoll" = "ws";
  private stopped = false;
  private readonly abort = new AbortController();
  private readonly acks = new Set<Promise<void>>();
  private firstOutcome: ((connected: boolean) => void) | null = null;
  private readonly o: Required<ReaderOptions>;

  constructor(client: ServerClient, name: string, o: ReaderOptions) {
    this.client = client;
    this.name = name;
    this.o = { backoff: [1000, 60_000], pingMs: 30_000, connectTimeoutMs: 15_000, ...o };
  }

  // Starts reading. Resolves true once connected, or false if the first
  // attempt failed (reading goes on retrying in the background). Throws
  // if the server refused for good.
  start(): Promise<boolean> {
    const first = new Promise<boolean>((resolve) => (this.firstOutcome = resolve));
    void this.run();
    return first.then((ok) => {
      if (this.failure) throw this.failure;
      return ok;
    });
  }

  // Events received and not yet acknowledged, oldest first.
  pending(): WatchEvent[] {
    this.fresh = false;
    return [...this.queue];
  }

  // Waits up to `ms` for events that pending() hasn't returned yet, or for
  // reading to fail. True if something happened.
  changed(ms: number): Promise<boolean> {
    if (this.fresh || this.failure) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (woke: boolean) => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve(woke);
      };
      const wake = () => done(true);
      const timer = setTimeout(() => done(false), ms);
      this.waiters.add(wake);
    });
  }

  // Moves the server's acknowledged position, over the socket if there is
  // one, else over HTTP.
  ack(seq: number): void {
    this.queue = this.queue.filter((e) => e.seq > seq);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "ack", seq }));
      return;
    }
    const sent: Promise<void> = this.client.ack(this.name, seq).then(
      () => {},
      (e: Error) => this.o.log(`couldn't acknowledge event ${seq} (${e.message}); it may be shown again`),
    ).finally(() => this.acks.delete(sent));
    this.acks.add(sent);
  }

  // Stops reading, after sending any acknowledgements still on their way.
  async close(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    const ws = this.ws;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        ws.addEventListener("close", () => {
          clearTimeout(timer);
          resolve();
        });
        ws.close(1000, "done");
      });
    }
    await Promise.all(this.acks);
    this.wake();
  }

  private async run(): Promise<void> {
    let delay = this.o.backoff[0];
    while (!this.stopped) {
      try {
        if (this.mode === "ws") {
          const { opened, code, reason } = await this.openSocket();
          if (this.stopped) break;
          if (!opened) {
            // No socket. Find out over HTTP whether the server is there at
            // all; this throws if it isn't, or if the key is wrong.
            await this.client.ensureInbox(this.name);
            this.o.log(`couldn't open a WebSocket to ${this.client.url}; long-polling instead`);
            this.mode = "longpoll";
            continue;
          }
          if (code === 4001) throw new LoginNeeded(`${this.client.url} rejected the API key (${reason || "4001"}); check WATCHERONI_API_KEY`);
          if (code === 4004) throw new ServerError(`inbox ${this.name} was deleted on ${this.client.url}`, 404, "not_found");
          if (code === 4029) {
            this.o.log(`${this.client.url} has too many connections for this account; long-polling instead`);
            this.mode = "longpoll";
            continue;
          }
          if (this.connected) delay = this.o.backoff[0];
          this.connected = false;
          throw new Unreachable(`lost the connection to ${this.client.url} (${code}${reason ? ` ${reason}` : ""})`);
        } else {
          // Ask without waiting first, so a (re)connection shows at once.
          let page: EventsPage;
          try {
            page = await this.client.events(this.name, this.pos, this.connected ? WAIT_SECONDS : 0, this.abort.signal);
          } catch (e) {
            // Too many long polls already waiting on this account: still
            // connected, but ask again later rather than at once.
            if (!(e instanceof Unreachable && e.code === "too_many_connections")) throw e;
            const seconds = e.retryAfter ?? CROWDED_RETRY_SECONDS;
            if (!this.crowded) this.o.log(`${this.client.url} has too many long polls waiting for this account; asking every ${seconds} s instead`);
            this.crowded = true;
            await this.pause(seconds * 1000);
            continue;
          }
          this.crowded = false;
          this.markConnected();
          if (this.pos === null) this.pos = page.acked;
          this.add(page.events);
          this.pos = Math.max(this.pos ?? 0, page.next);
          delay = this.o.backoff[0];
        }
      } catch (e) {
        if (this.stopped) break;
        if (!(e instanceof Unreachable)) {
          this.fail(e as Error);
          break;
        }
        this.connected = false;
        this.settleFirst(false);
        if (!this.outage) {
          this.outage = true;
          // The first failure is reported by whoever called start().
          if (this.wasConnected) this.o.log(`${e.message}; reconnecting`);
        }
        const jittered = delay * (0.5 + Math.random() / 2);
        await new Promise((r) => setTimeout(r, jittered));
        delay = Math.min(delay * 2, this.o.backoff[1]);
      }
    }
  }

  private wasConnected = false;
  private outage = false;
  private crowded = false;

  // Sleeps for `ms`, or until close().
  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.abort.signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.abort.signal.addEventListener("abort", done, { once: true });
    });
  }

  private markConnected(): void {
    if (this.outage) this.o.log(`${this.wasConnected ? "reconnected" : "connected"} to ${this.client.url}`);
    this.outage = false;
    this.connected = true;
    this.wasConnected = true;
    this.settleFirst(true);
  }

  private settleFirst(connected: boolean): void {
    this.firstOutcome?.(connected);
    this.firstOutcome = null;
  }

  private fail(e: Error): void {
    this.failure = e;
    this.connected = false;
    this.settleFirst(false);
    this.wake();
  }

  // One WebSocket connection, from opening to closing.
  private async openSocket(): Promise<{ opened: boolean; code: number; reason: string }> {
    const { url, headers } = await this.client.socket(this.name);
    return new Promise((resolve) => {
      const ws = new WebSocket(url, { protocols: [SUBPROTOCOL], headers });
      let opened = false;
      let heard = Date.now();
      const connectTimer = setTimeout(() => ws.close(), this.o.connectTimeoutMs);
      // Keepalive: the server answers `ping` with `pong` without waking.
      // Nothing heard for two rounds means the connection is dead.
      const pinger = setInterval(() => {
        if (Date.now() - heard > 2.5 * this.o.pingMs) ws.close(4000, "silent");
        else if (ws.readyState === WebSocket.OPEN) ws.send("ping");
      }, this.o.pingMs);
      ws.addEventListener("open", () => {
        opened = true;
        clearTimeout(connectTimer);
        ws.send(JSON.stringify(this.pos === null ? { type: "hello" } : { type: "hello", after: this.pos }));
      });
      ws.addEventListener("message", (m) => {
        heard = Date.now();
        if (m.data === "pong" || typeof m.data !== "string") return;
        let msg: ServerMessage;
        try {
          msg = JSON.parse(m.data) as ServerMessage;
        } catch {
          return;
        }
        if (msg.type === "ready") {
          this.ws = ws;
          if (this.pos === null) this.pos = msg.acked;
          this.markConnected();
        } else if (msg.type === "events") {
          this.add(msg.events);
        } else if (msg.type === "error") {
          this.o.log(`${this.client.url}: ${msg.code}${msg.detail ? `: ${msg.detail}` : ""}`);
        }
      });
      const onAbort = () => {
        if (ws.readyState === WebSocket.CONNECTING) ws.close();
      };
      const finish = (code: number, reason: string) => {
        clearTimeout(connectTimer);
        clearInterval(pinger);
        this.abort.signal.removeEventListener("abort", onAbort);
        if (this.ws === ws) this.ws = null;
        resolve({ opened, code, reason });
      };
      ws.addEventListener("close", (ev) => finish(ev.code, ev.reason));
      // An error is followed by close, except on Node 22, whose WebSocket
      // fires only the error when the handshake fails (a non-101 answer,
      // such as a wrong key), so a failed open ends here.
      ws.addEventListener("error", () => {
        if (!opened) finish(1006, "");
      });
      this.abort.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  // Keeps new events, dropping ones already seen (delivery is at least once).
  private add(events: WatchEvent[]): void {
    let added = false;
    for (const e of events) {
      if (this.pos !== null && e.seq <= this.pos) continue;
      this.pos = e.seq;
      if (this.seen.has(e.id)) continue;
      this.seen.add(e.id);
      this.queue.push(e);
      added = true;
    }
    if (this.seen.size > 2000) this.seen = new Set([...this.seen].slice(-1000));
    if (added) {
      this.fresh = true;
      this.wake();
    }
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }
}
