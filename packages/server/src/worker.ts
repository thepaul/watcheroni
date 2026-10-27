// Prototype Worker: one Account Durable Object with hibernated WebSockets
// and the long-poll bridge described in DESIGN.md. Login, API keys,
// tickets and RepoHub are left out; a single shared PROTO_TOKEN stands in
// for authentication, and /debug stands in for webhooks.

import type { Account, Delivery } from "./account";
import {
  INBOX_NAME,
  MAX_LIMIT,
  MAX_WAIT_SECONDS,
  json,
  problem,
  type EventsPage,
  type DataValue,
  type ServerMessage,
  type WatchEvent,
} from "./protocol";

export { Account } from "./account";

// Everything in the prototype belongs to one account.
const ACCOUNT_NAME = "acct:proto";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/healthz") return new Response("ok");
    if (pathname === "/v1/meta" && request.method === "GET") {
      return json({
        protocol: 1,
        server: "watcheroni/0.0.0-proto",
        features: ["ws", "longpoll"],
        limits: { max_wait_seconds: MAX_WAIT_SECONDS },
      });
    }

    if (!(await authorized(request, url, env))) {
      return problem(401, "unauthorized", "Missing or wrong token");
    }
    const account = env.ACCOUNT.get(env.ACCOUNT.idFromName(ACCOUNT_NAME));

    if (pathname === "/debug/stats" && request.method === "GET") {
      return json(await account.stats());
    }

    const m = pathname.match(/^\/(v1|debug)\/inboxes\/([^/]+)(\/[a-z]+)?$/);
    if (!m) return problem(404, "not_found", "No such endpoint");
    const [, area, rawName, rest = ""] = m;
    const name = decodeURIComponent(rawName);
    if (!INBOX_NAME.test(name)) return problem(400, "invalid_request", "Bad inbox name");
    const route = `${request.method} /${area}/inboxes/{name}${rest}`;

    switch (route) {
      case "PUT /v1/inboxes/{name}":
        return json(await account.ensureInbox(name));

      case "GET /v1/inboxes/{name}/events":
        return longPoll(account, name, url, request.signal);

      case "POST /v1/inboxes/{name}/ack": {
        const body = await readJson<{ seq?: unknown }>(request);
        if (typeof body?.seq !== "number") return problem(400, "invalid_request", "Body must be {\"seq\": number}");
        const inbox = await account.ack(name, body.seq);
        return inbox ? json(inbox) : problem(404, "not_found", "No such inbox");
      }

      case "GET /v1/inboxes/{name}/ws": {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
          return problem(426, "invalid_request", "Expected a WebSocket upgrade");
        }
        const target = new URL("https://account/ws");
        target.searchParams.set("inbox", name);
        target.searchParams.set("mode", "client");
        return account.fetch(new Request(target, request));
      }

      // Stands in for RepoHub: inject synthetic events.
      case "POST /debug/inboxes/{name}/events": {
        const body = (await readJson<{ kind?: string; data?: { [key: string]: DataValue }; count?: number }>(request)) ?? {};
        const count = Math.min(Math.max(body.count ?? 1, 1), 100);
        const now = new Date().toISOString();
        const items: Delivery[] = Array.from({ length: count }, () => ({
          inbox: name,
          event: {
            v: 1,
            id: `debug:${crypto.randomUUID()}`,
            sub: null,
            kind: body.kind ?? "debug.ping",
            at: now,
            received_at: now,
            repo: null,
            pr: null,
            actor: null,
            data: body.data ?? {},
            links: {},
          },
        }));
        return json(await account.deliver(items));
      }
    }
    return problem(404, "not_found", "No such endpoint");
  },
} satisfies ExportedHandler<Env>;

// GET /v1/inboxes/{name}/events?after=&wait=&limit=
//
// Answers at once if there is anything to return. Otherwise the Worker,
// not the Durable Object, does the waiting: it opens its own WebSocket to
// the Account object and waits on it. The object can hibernate meanwhile,
// and a Worker is billed for CPU, not for time spent waiting.
async function longPoll(
  account: DurableObjectStub<Account>,
  name: string,
  url: URL,
  signal: AbortSignal,
): Promise<Response> {
  const after = intParam(url, "after");
  const wait = clamp(intParam(url, "wait") ?? 0, 0, MAX_WAIT_SECONDS);
  const limit = clamp(intParam(url, "limit") ?? 100, 1, MAX_LIMIT);

  const first = await account.readEvents(name, after, limit);
  if (!first) return problem(404, "not_found", "No such inbox");
  if (first.events.length || wait === 0) return json(first);

  const target = new URL("https://account/ws");
  target.searchParams.set("inbox", name);
  target.searchParams.set("mode", "bridge");
  target.searchParams.set("after", String(first.next));
  const upgraded = await account.fetch(target, { headers: { Upgrade: "websocket" } });
  const ws = upgraded.webSocket;
  if (!ws) return problem(503, "unavailable", "Could not open the bridge");
  ws.accept();

  const events = await firstEvents(ws, wait * 1000, signal);
  try {
    ws.close(1000, "done");
  } catch {
    // Already closed.
  }

  if (!events.length) return json(first);
  const page = events.slice(0, limit);
  const last = page[page.length - 1].seq;
  const result: EventsPage = { events: page, next: last, head: Math.max(first.head, last), acked: first.acked };
  return json(result);
}

// Resolves with the first batch of events on the socket, or an empty list
// on timeout, close, or the client hanging up.
function firstEvents(ws: WebSocket, timeoutMs: number, signal: AbortSignal): Promise<WatchEvent[]> {
  return new Promise((resolve) => {
    const done = (events: WatchEvent[]) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(events);
    };
    const onAbort = () => done([]);
    const timer = setTimeout(() => done([]), timeoutMs);
    signal.addEventListener("abort", onAbort);
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as ServerMessage;
        if (msg.type === "events") done(msg.events);
      } catch {
        // Ignore anything that isn't ours.
      }
    });
    ws.addEventListener("close", () => done([]));
    ws.addEventListener("error", () => done([]));
  });
}

// The prototype's stand-in for API keys and tickets: a shared token in
// the Authorization header, or ?token= for WebSocket clients that can't
// set headers.
async function authorized(request: Request, url: URL, env: Env): Promise<boolean> {
  const header = request.headers.get("Authorization");
  const given = header?.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("token");
  if (!given || !env.PROTO_TOKEN) return false;
  const [a, b] = await Promise.all([sha256(given), sha256(env.PROTO_TOKEN)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function sha256(s: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

function intParam(url: URL, key: string): number | null {
  const v = url.searchParams.get(key);
  if (v === null || !/^\d+$/.test(v)) return null;
  return Number(v);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}
