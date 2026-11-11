import { join } from "node:path";
import type { EventsPage, InboxInfo, InboxesResponse, ServerMessage, SubscriptionInfo, SubscriptionRequest, SubscriptionsResponse, WatchEvent } from "@watcheroni/protocol";
import pkg from "../package.json" with { type: "json" };
import { type ServerConfig, checkServerUrl, configDir } from "./config.ts";
import { clean, PROSE_LENGTH } from "./format.ts";
import { LoginNeeded } from "./github.ts";
import { githubUrl } from "./login.ts";
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

// A 2xx answer whose body isn't JSON. Tried again like any Unreachable;
// a long poll also warns of it as a malformed page.
export class MalformedAnswer extends Unreachable {}

// A long poll refused because too many are already waiting on the account
// is asked again this often, unless the server says otherwise.
const CROWDED_RETRY_SECONDS = 30;

// Reading stopped for something on this machine, already explained in
// the log (see ServerReader's keepTakenBack()).
export class ReadingStopped extends Error {}

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

// Why the server refused, from its problem document, made fit to print.
export function refusal(problem: { detail?: unknown; title?: unknown }, code: string): string {
  return clean(problem.detail ?? problem.title ?? code, PROSE_LENGTH);
}

// 401s that are about the GitHub token sent with a request, not the API key.
const GITHUB_TOKEN_CODES = new Set(["github_token_required", "github_token_invalid"]);

// Redirects are never followed on requests to the server, nor on the
// device flow's to github.com: fetch would send the body again wherever
// one points, even to plain http, and those bodies carry GitHub tokens
// and the device code. Each of them passes this, and answers a redirect
// with an error saying so (see redirect()). Local mode's GraphQL requests
// to GitHub follow them: their body is only the query, and fetch drops
// the Authorization header on a redirect to another origin, https to http
// included.
export const NO_REDIRECTS = { redirect: "manual" } as const;

// What to do about a server that redirects: where its URL is set.
export function checkServerUrlHint(): string {
  return `check the server URL in $WATCHERONI_SERVER or ${join(configDir(), "config.json")}`;
}

// What to say about an answer that is a redirect, or null if it isn't.
export function redirect(res: Response): string | null {
  if (res.type !== "opaqueredirect" && (res.status < 300 || res.status > 399)) return null;
  const to = res.headers.get("Location");
  return `answered ${res.status} redirecting${to ? ` to ${JSON.stringify(clean(to, 200))}` : ""}, which watcheroni doesn't follow`;
}

const SUBPROTOCOL = "watcheroni.v1";
const WAIT_SECONDS = 300;

export class ServerClient {
  readonly url: string;
  private readonly apiKey: string;

  constructor(config: ServerConfig) {
    this.url = checkServerUrl(config.url);
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
        ...NO_REDIRECTS,
      });
    } catch (e) {
      if (o.signal?.aborted) throw e;
      const cause = (e as Error & { cause?: Error }).cause;
      throw new Unreachable(`can't reach ${this.url}: ${cause?.message ?? (e as Error).message}`);
    }
    // Not worth retrying: the server URL, or the server, needs fixing.
    const moved = redirect(res);
    if (moved) {
      const detail = `${moved}; ${checkServerUrlHint()}`;
      throw new ServerError(`${this.url}: ${method} ${path}: ${detail}`, res.status, "redirect", { detail });
    }
    if (res.status === 204) return undefined as T;
    if (res.ok) {
      // The body can still fail after the headers came: cut off, timed
      // out, or not JSON (a captive portal's page, say). Each is worth
      // trying again, like a connection that failed.
      try {
        return (await res.json()) as T;
      } catch (e) {
        if (o.signal?.aborted) throw e;
        if (e instanceof SyntaxError) throw new MalformedAnswer(`${this.url} sent an answer to ${method} ${clean(path, PROSE_LENGTH)} that isn't JSON`);
        const cause = (e as Error & { cause?: Error }).cause;
        throw new Unreachable(`lost the answer from ${this.url}: ${clean(cause?.message ?? (e as Error).message, PROSE_LENGTH)}`);
      }
    }
    const problem = (await res.json().catch(() => ({}))) as { code?: string; title?: string; detail?: string };
    const code = problem.code ?? String(res.status);
    // The problem's fields are the server's to choose, so they are cleaned
    // before they get near a terminal.
    if (res.status === 401 && !GITHUB_TOKEN_CODES.has(code)) {
      throw new LoginNeeded(`${this.url} rejected the API key (${clean(code)}); check WATCHERONI_API_KEY`);
    }
    if (res.status >= 500 || res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After"));
      throw new Unreachable(`${this.url} answered ${res.status} (${clean(code)}${problem.title ? `: ${clean(problem.title, PROSE_LENGTH)}` : ""})`, {
        code,
        retryAfter: retryAfter > 0 ? retryAfter : null,
      });
    }
    throw new ServerError(`${this.url}: ${method} ${clean(path, PROSE_LENGTH)}: ${res.status} ${refusal(problem, code)}`, res.status, code, problem);
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
    // checkServerUrl has made sure plain http only goes to this machine.
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
        // Shown only if it's a github.com page, like the sign-in page.
        const install = githubUrl(e.problem.install_url);
        const url = install ? `; it can be installed from ${install}` : "";
        o.log(`the watcheroni App isn't installed on ${repo}${url}`);
      } else if (e.code === "github_token_invalid") {
        o.log(`${client.url} didn't accept this machine's GitHub token for ${repo}; run \`watcheroni login\` again`);
      } else {
        o.log(`${client.url} won't watch ${anyKey(target)}: ${refusal(e.problem, e.code)}`);
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

// What became of a stale inbox's copy on the server (see sweep() in
// inbox.ts): `done` once there's none left for this machine to delete;
// otherwise `retryAfter` (seconds) if the server said when to try again.
export type StaleInboxOutcome = { done: true } | { done: false; retryAfter: number | null };

// Deletes, for one sweep, the server's copies of inboxes nobody has opened
// on this machine for `staleMs`, with their subscriptions (PROTOCOL.md,
// "Inboxes"). The local inbox is the server's of the same name: every
// command that reads one with a server makes sure of the other
// (ensureInbox).
//
// - A server without these routes (GET /v1/inboxes answers 404) can't be
//   asked: the local file goes, and the server's inbox ends by itself.
// - One made or read on the server within `staleMs`, from another machine,
//   say, is in use, just not from here: left alone.
// - One the server doesn't have (404) is done.
// - One that can't be deleted now (unreachable, refused, or a 503 when not
//   every subscription could be ended) isn't: its local file is kept so a
//   later sweep tries again.
export function staleInboxDeleter(
  client: ServerClient,
  staleMs: number,
  log: (msg: string) => void,
  timeoutMs: number,
): (name: string) => Promise<StaleInboxOutcome> {
  let supported: Promise<boolean | StaleInboxOutcome> | null = null;
  const failed = (name: string, e: unknown): StaleInboxOutcome => {
    if (e instanceof Unreachable) {
      // A server that answered, but not when to try again, is worth a word;
      // one that can't be reached is said by the command itself.
      if (e.code !== null && e.retryAfter === null) log(`couldn't delete inbox ${name}, unused here for a week, on ${client.url}: ${e.message}`);
      return { done: false, retryAfter: e.retryAfter };
    }
    if (e instanceof ServerError || e instanceof LoginNeeded) {
      log(`couldn't delete inbox ${name}, unused here for a week, on ${client.url}: ${e.message}`);
      return { done: false, retryAfter: null };
    }
    throw e;
  };
  return async (name) => {
    supported ??= client.request<InboxesResponse>("GET", "/v1/inboxes", { timeoutMs }).then(
      () => true,
      (e: unknown) => (e instanceof ServerError && e.status === 404 ? false : failed(name, e)),
    );
    const ok = await supported;
    if (ok === false) return { done: true };
    if (ok !== true) {
      // Asked again next time; only a definite answer is kept.
      supported = null;
      return ok;
    }
    return deleteStaleInbox(client, name, staleMs, failed, timeoutMs);
  };
}

async function deleteStaleInbox(
  client: ServerClient,
  name: string,
  staleMs: number,
  failed: (name: string, e: unknown) => StaleInboxOutcome,
  timeoutMs: number,
): Promise<StaleInboxOutcome> {
  const path = `/v1/inboxes/${name}`;
  let info: InboxInfo;
  try {
    info = await client.request<InboxInfo>("GET", path, { timeoutMs });
  } catch (e) {
    return e instanceof ServerError && e.status === 404 ? { done: true } : failed(name, e);
  }
  // Without both times, whether it's in use can't be told, so it's kept.
  const created = Date.parse(String(info?.created_at));
  const read = info?.last_read_at === null ? created : Date.parse(String(info?.last_read_at));
  if (Number.isNaN(created) || Number.isNaN(read)) {
    return failed(name, new ServerError(`its answer doesn't say when it was made and last read`, 200, "malformed"));
  }
  if (Date.now() - Math.max(created, read) < staleMs) return { done: true };
  try {
    await client.request("DELETE", path, { timeoutMs });
    return { done: true };
  } catch (e) {
    return e instanceof ServerError && e.status === 404 ? { done: true } : failed(name, e);
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
  // The repos' names are as the server gave them. GitHub's are at most
  // 140 characters.
  const name = (s: SubscriptionInfo) => clean(s.repo.full_name, 140);
  let token: string | null | undefined;
  try {
    token = await o.githubToken?.();
  } catch (e) {
    if (!(e instanceof Unreachable)) throw e;
    o.log(`couldn't renew the server's watch on ${due.map(name).join(", ")}: ${e.message}`);
    return;
  }
  if (!token) {
    o.log(`the server needs a fresh GitHub token to keep watching ${due.map(name).join(", ")}; run \`watcheroni login\``);
    return;
  }
  for (const s of due) {
    try {
      await client.request("POST", `/v1/inboxes/${inbox}/subscriptions/${encodeURIComponent(s.id)}/verify`, { headers: { "X-GitHub-Token": token } });
    } catch (e) {
      if (e instanceof ServerError) {
        o.log(e.code === "repo_access_denied"
          ? `you can no longer read ${name(s)}, so the server has stopped watching it`
          : `couldn't renew the server's watch on ${name(s)}: ${refusal(e.problem, e.code)}`);
        continue;
      }
      if (e instanceof Unreachable || e instanceof LoginNeeded) return;
      throw e;
    }
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isSeq = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

// Whether an event from the server has the shape the CLI reads: fields
// it reads as text or numbers are text or numbers, and what it looks
// inside is an object. The fields that may be null may also be missing.
// New kinds and new fields always pass.
function wellFormed(e: unknown): e is WatchEvent {
  if (!isObject(e)) return false;
  const { id, kind, seq, sub, data, links, repo, pr, actor } = e;
  return typeof id === "string" && typeof kind === "string" && isSeq(seq)
    && (sub == null || typeof sub === "string")
    && isObject(data) && isObject(links)
    && (repo == null || (isObject(repo) && typeof repo.full_name === "string"))
    && (pr == null || typeof pr === "number")
    && (actor == null || isObject(actor));
}

// What can be told of a malformed event, cleaned: its kind, repo, PR,
// seq and ID, where they're the right type.
function describeMalformed(e: unknown): string {
  const f = isObject(e) ? e : {};
  const repo = isObject(f.repo) && typeof f.repo.full_name === "string" ? clean(f.repo.full_name, 140) : null;
  const pr = typeof f.pr === "number" && Number.isSafeInteger(f.pr) ? f.pr : null;
  return [
    typeof f.kind === "string" ? `kind ${JSON.stringify(clean(f.kind))}` : null,
    repo && (pr === null ? repo : `${repo}#${pr}`),
    isSeq(f.seq) ? `seq ${f.seq}` : null,
    typeof f.id === "string" ? `id ${JSON.stringify(clean(f.id))}` : null,
  ].filter(Boolean).join(", ");
}

// What to do about something from the server that isn't as the protocol
// has it.
const REPORT = "if this keeps happening, report it to the server's operator";

export interface ReaderOptions {
  log: (msg: string) => void;
  // Takes the events pending when an inbox.gap moves the position back
  // (see add()), to keep them where they outlive this process: their seqs
  // are from before, and mean nothing to the server now.
  takeBack: (events: WatchEvent[]) => void;
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

  // The last seq read: everything at or below it has been received.
  private pos: number | null = null;
  // Events received and not yet handled, by seq.
  private queue: WatchEvent[] = [];
  // The server's acknowledged position, as it last said or was last told.
  private acked: number | null = null;
  // Whether the position is ahead of the inbox's head, as the server said
  // at the start of this connection: the inbox's numbering went back, and
  // an inbox.gap that moves the position back is on its way. Till then
  // nothing is acknowledged: the server ignores a position past its head,
  // and one from before it would be a guess at what was read.
  private ahead = false;
  // Why reading must stop, found where it can't be thrown (see add()).
  private fatal: Error | null = null;
  // IDs of events received, to drop one sent again (delivery is at least
  // once).
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

  // Events received and not yet handled, in the order to show them.
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

  // Takes exactly these events (as pending() gave them) as handled, and
  // acknowledges what that lets the server forget (see acknowledge()).
  // Events that came meanwhile, whatever their seq, stay pending.
  handled(events: WatchEvent[]): void {
    const done = new Set(events);
    this.queue = this.queue.filter((e) => !done.has(e));
    this.acknowledge();
  }

  // Moves the server's acknowledged position, over the socket if there is
  // one, else over HTTP, to the highest seq read with nothing still
  // pending at or below it: events handled, sent again, or malformed and
  // dropped. Sends nothing if that isn't past where the server already is,
  // while the position is ahead of the inbox's head (see `ahead`), or
  // while not connected: the next connection's ready does it then.
  private acknowledge(): void {
    if (this.pos === null || this.ahead || !this.connected) return;
    // Defensive: `connected` is cleared only once run() hears the socket
    // closed, so an ack meant for it mustn't go over HTTP meanwhile.
    if (this.mode === "ws" && this.ws?.readyState !== WebSocket.OPEN) return;
    let seq = this.pos;
    for (const e of this.queue) if (e.seq <= seq) seq = e.seq - 1;
    if (seq < 0 || (this.acked !== null && seq <= this.acked)) return;
    this.acked = seq;
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
          if (this.fatal) throw this.fatal;
          if (!opened) {
            // No socket. Find out over HTTP whether the server is there at
            // all; this throws if it isn't, or if the key is wrong.
            await this.client.ensureInbox(this.name);
            this.o.log(`couldn't open a WebSocket to ${this.client.url}; long-polling instead`);
            this.mode = "longpoll";
            continue;
          }
          // Closed for a malformed message: reconnected with backoff that
          // grows as for a server that's down, even after a sound ready,
          // so a server that sends nothing else isn't asked every second.
          // One that also sent events soundly starts the backoff again.
          if (this.brokenBy) {
            const what = this.brokenBy;
            this.brokenBy = null;
            if (this.readSince) delay = this.o.backoff[0];
            this.readSince = false;
            throw new Unreachable(`${this.client.url} sent a malformed ${what}`);
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
            // An answer that isn't JSON at all (a captive portal's page,
            // say) is a malformed page, tried again.
            if (e instanceof MalformedAnswer) {
              this.malformed("page of events");
              throw new Unreachable(`${this.client.url} sent a malformed page of events`);
            }
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
          // A page that can't be read is taken like a 5xx (see malformed()).
          if (!isObject(page) || !Array.isArray(page.events) || !isSeq(page.next) || (this.pos === null && !isSeq(page.acked))) {
            this.malformed("page of events");
            throw new Unreachable(`${this.client.url} sent a malformed page of events`);
          }
          this.markConnected();
          if (this.pos === null) this.pos = page.acked;
          if (isSeq(page.acked)) this.acked = page.acked;
          // Defensive: a sound server answers a position ahead of head with
          // the gap that moves it back in this same page.
          if (!isSeq(page.head)) this.noHead("page of events");
          this.ahead = isSeq(page.head) && this.pos > page.head;
          this.add(page.events);
          this.pos = Math.max(this.pos ?? 0, page.next);
          this.acknowledge();
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
  private readonly warned = new Set<string>();
  // What the last WebSocket was closed for, if it was malformed, and
  // whether it brought a sound events message since its ready.
  private brokenBy: string | null = null;
  private readSince = false;
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

  // Something from the server that isn't as the protocol has it, taken
  // like a lost connection: tried again with backoff, the position
  // unmoved. Warned of once for each `what`; that warning stands for the
  // outage's own, which is otherwise logged when the error is caught.
  private malformed(what: string): void {
    if (this.warned.has(what)) return;
    this.warned.add(what);
    this.o.log(`${this.client.url} sent a malformed ${what}: it isn't shaped as the protocol says; ${REPORT}`);
    this.outage = true;
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
    // Whether events were read soundly is per connection: one closed
    // before its ready mustn't count what the last one read.
    this.readSince = false;
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
        if (m.data === "pong") return;
        // A message that isn't as the protocol has it, binary or not even
        // JSON included, may have carried events, which the server now
        // counts as sent on this connection. So it's closed, and the next
        // one's hello asks again from the last event read (see run()).
        // One of a type this version doesn't know is ignored; one with no
        // type at all is malformed.
        const broken = (what: string) => {
          this.malformed(what);
          this.brokenBy = what;
          ws.close(4000, `malformed ${what}`);
        };
        if (typeof m.data !== "string") return broken("binary message");
        let msg: ServerMessage;
        try {
          msg = JSON.parse(m.data) as ServerMessage;
        } catch {
          return broken("message");
        }
        if (!isObject(msg) || typeof msg.type !== "string") {
          broken("message");
        } else if (msg.type === "ready") {
          if (!isSeq(msg.acked)) return broken("ready message");
          this.ws = ws;
          this.acked = msg.acked;
          if (!isSeq(msg.head)) this.noHead("ready message");
          this.ahead = this.pos !== null && isSeq(msg.head) && this.pos > msg.head;
          if (this.pos === null) this.pos = msg.acked;
          this.markConnected();
          // Anything handled while there was no connection.
          this.acknowledge();
        } else if (msg.type === "events") {
          if (!Array.isArray(msg.events)) return broken("events message");
          // Only a batch with a sound event past the position counts as
          // read soundly. An empty one, one whose events are all at or
          // below the position, or one that only moves it back (an
          // inbox.gap) says nothing of the server.
          try {
            if (this.add(msg.events)) this.readSince = true;
          } catch (e) {
            // What add() can't go on from (see keepTakenBack()): reading
            // stops once the socket is closed.
            this.fatal = e as Error;
            ws.close(4000, "stopping");
          }
        } else if (msg.type === "error") {
          // The server's own words, cleaned like the rest.
          this.o.log(`${this.client.url}: ${clean(msg.code)}${msg.detail ? `: ${clean(msg.detail, PROSE_LENGTH)}` : ""}`);
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
        // The reason is the server's to choose, like the text it sends.
        resolve({ opened, code, reason: clean(reason) });
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

  // Keeps new events, dropping ones already received (delivery is at
  // least once). An event that isn't the shape PROTOCOL.md gives can throw
  // where it's read (a kind that isn't text, data that isn't an object),
  // and, never acknowledged, would come back on every run. It's dropped
  // with a warning instead, and acknowledged once nothing before it is
  // pending (see acknowledge()). One without a sound seq can't be placed;
  // acknowledging a later event moves past it. A missing nullable field
  // is kept as null. Says whether a sound event moved the position on.
  private add(events: WatchEvent[]): boolean {
    let added = false;
    let advanced = false;
    // Events whose seq was at or below the position (see below).
    const late: number[] = [];
    let lateAfter = 0;
    for (const e of events as unknown[]) {
      const sound = wellFormed(e);
      // An `inbox.gap` for a position ahead of the inbox's `head` takes it
      // back (PROTOCOL.md, "Gaps"). This comes before anything at or below
      // the position is passed over, since the gap itself is below it.
      // What's pending is from before the gap: it's handed to takeBack,
      // which keeps it to be shown, and is no longer this reader's (nor
      // the server's) to acknowledge.
      const back = sound && e.kind === "inbox.gap" && this.pos !== null && e.seq < this.pos && e.data.missed_after === this.pos;
      if (back) {
        if (this.queue.length) this.keepTakenBack(this.queue);
        this.queue = [];
        this.ahead = false;
      }
      if (!sound) {
        const seq = isObject(e) ? e.seq : undefined;
        // Only one past the position is placed, to be acknowledged; one
        // at or below it is still warned of, never dropped unsaid.
        const placed = isSeq(seq) && (this.pos === null || seq > this.pos);
        if (placed) this.pos = seq;
        const what = describeMalformed(e);
        this.o.log(`dropped a malformed event from ${this.client.url}${what ? ` (${what})` : ""}: it isn't shaped as the protocol says${placed ? ", so it's acknowledged unshown" : ""}; ${REPORT}`);
        continue;
      }
      const event: WatchEvent = { ...e, sub: e.sub ?? null, actor: e.actor ?? null, repo: e.repo ?? null, pr: e.pr ?? null };
      if (!back && this.pos !== null && e.seq <= this.pos) {
        // At or below the position: one already received is dropped
        // quietly. Any other is the server's seqs going back, which a
        // sound server never does; it's kept, in seq order, so nothing is
        // lost, and warned of (once for the batch).
        if (this.seen.has(e.id)) continue;
        this.seen.add(e.id);
        late.push(e.seq);
        lateAfter = this.pos;
        let i = this.queue.length;
        while (i > 0 && this.queue[i - 1].seq > e.seq) i--;
        this.queue.splice(i, 0, event);
        added = true;
        continue;
      }
      this.pos = e.seq;
      if (!back) advanced = true;
      if (this.seen.has(e.id)) continue;
      this.seen.add(e.id);
      this.queue.push(event);
      added = true;
    }
    if (late.length) {
      let lo = late[0];
      let hi = late[0];
      for (const s of late) {
        if (s < lo) lo = s;
        if (s > hi) hi = s;
      }
      const which = late.length === 1 ? `an event out of order (seq ${lo}` : `${late.length} events out of order (seqs ${lo} to ${hi}`;
      this.o.log(`${this.client.url} sent ${which} after ${lateAfter}); ${late.length === 1 ? "it's" : "they're"} shown anyway; ${REPORT}`);
    }
    if (this.seen.size > 2000) this.seen = new Set([...this.seen].slice(-1000));
    // Malformed ones and ones sent again, with nothing pending before
    // them, are acknowledged now.
    this.acknowledge();
    if (added) {
      this.fresh = true;
      this.wake();
    }
    return advanced;
  }

  // Hands what a gap took back to takeBack. If that fails (the local
  // inbox can't be saved, say), they can't be kept: each is named, so
  // it's known what to look up on GitHub, and reading stops, as nothing
  // after the gap can be acknowledged soundly without them.
  private keepTakenBack(events: WatchEvent[]): void {
    try {
      this.o.takeBack(events);
    } catch (e) {
      const named = events.map((q) => {
        const where = q.repo ? (q.pr === null ? clean(q.repo.full_name, 140) : `${clean(q.repo.full_name, 140)}#${q.pr}`) : null;
        return `${clean(q.kind)}${where ? ` on ${where}` : ""} (id ${JSON.stringify(clean(q.id))})`;
      });
      const why = clean((e as Error)?.message ?? e, PROSE_LENGTH);
      this.o.log(`couldn't keep ${events.length === 1 ? "the event" : `the ${events.length} events`} received before an inbox.gap from ${this.client.url} (${why}), so ${events.length === 1 ? "it's" : "they're"} lost: ${named.join(", ")}; check on GitHub`);
      throw new ReadingStopped(`stopped reading inbox ${this.name}: couldn't keep events received before an inbox.gap (${why})`);
    }
  }

  // A ready or page without a sound head: a position ahead of it can't be
  // noticed (see `ahead`). Warned of once for each.
  private noHead(what: string): void {
    const key = `no head: ${what}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.o.log(`${this.client.url} sent a ${what} without a sound head; ${REPORT}`);
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }
}
