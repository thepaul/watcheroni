// Prototype Worker: one Account Durable Object with hibernated WebSockets
// and the long-poll bridge described in DESIGN.md, and RepoHub. Login, API
// keys and tickets are left out; a single shared PROTO_TOKEN stands in for
// authentication. GitHub webhooks are verified, normalised and sent to
// RepoHub; subscriptions are made through /debug until /v1 has sign-in.

import type { Account, Delivery } from "./account";
import type { NewSubscription, PrBaseline } from "./repo-hub";
import { normalise } from "./webhook/normalise";
import { verifySignature } from "./webhook/signature";
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
export { RepoHub } from "./repo-hub";

// Everything in the prototype belongs to one account.
const ACCOUNT_NAME = "acct:proto";

const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;

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

    if (pathname === "/github/webhook" && request.method === "POST") {
      return webhook(request, env);
    }

    if (!(await authorized(request, url, env))) {
      return problem(401, "unauthorized", "Missing or wrong token");
    }
    const account = env.ACCOUNT.get(env.ACCOUNT.idFromName(ACCOUNT_NAME));

    if (pathname === "/debug/stats" && request.method === "GET") {
      return json(await account.stats());
    }

    const repoRoute = pathname.match(/^\/debug\/repos\/(\d+)(?:\/subscriptions(?:\/([^/]+))?)?$/);
    if (repoRoute) return debugRepo(request, env, Number(repoRoute[1]), repoRoute[0].includes("/subscriptions"), repoRoute[2]);

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

// POST /github/webhook: steps 1, 3 and 4 of "Webhook handling in the
// Worker" in DESIGN.md. The response lists the events and what RepoHub did
// with them, which GitHub ignores and tests and tools read.
async function webhook(request: Request, env: Env): Promise<Response> {
  const body = await request.arrayBuffer();
  // Parsing costs about 2.5 ms of CPU a megabyte, and the free plan allows
  // 10 ms a request. None of the events the App subscribes to come near
  // this size; see "Webhook CPU" in DESIGN.md.
  if (body.byteLength > MAX_WEBHOOK_BYTES) {
    console.warn(`webhook ${request.headers.get("X-GitHub-Delivery")} dropped: ${body.byteLength} bytes`);
    return problem(413, "too_large", "Webhook body too large");
  }
  if (!(await verifySignature(body, request.headers.get("X-Hub-Signature-256"), [env.GITHUB_WEBHOOK_SECRET]))) {
    return problem(401, "unauthorized", "Bad webhook signature");
  }
  const event = request.headers.get("X-GitHub-Event") ?? "";
  const delivery = request.headers.get("X-GitHub-Delivery") ?? crypto.randomUUID();
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return problem(400, "invalid_request", "Body is not JSON");
  }
  const events = normalise(event, delivery, payload, new Date().toISOString());
  // Deliveries that normalise to nothing never reach a Durable Object.
  const repoId = events[0]?.repo?.id;
  const ingest = repoId ? await env.REPO_HUB.get(env.REPO_HUB.idFromName(`repo:${repoId}`)).ingest(delivery, events) : null;
  return json({ events, ingest }, 202);
}

// Stands in for the /v1 subscription endpoints until sign-in exists:
//   GET    /debug/repos/{id}                     RepoHub's state
//   POST   /debug/repos/{id}/subscriptions       {account, inbox, pr, kinds?, ignore?, full_name?, baseline?}
//   DELETE /debug/repos/{id}/subscriptions/{sub}
async function debugRepo(request: Request, env: Env, repoId: number, subs: boolean, subId?: string): Promise<Response> {
  const hub = env.REPO_HUB.get(env.REPO_HUB.idFromName(`repo:${repoId}`));
  if (!subs && request.method === "GET") return json(await hub.stats());
  if (subs && !subId && request.method === "POST") {
    const body = await readJson<NewSubscription & { full_name?: string; private?: boolean; baseline?: PrBaseline }>(request);
    if (!body || typeof body.inbox !== "string" || !INBOX_NAME.test(body.inbox)) {
      return problem(400, "invalid_request", "Body needs account, inbox and pr");
    }
    const { full_name = `repo-${repoId}`, private: isPrivate, baseline, ...sub } = body;
    const result = await hub.subscribe({ ...sub, pr: sub.pr ?? null }, { id: repoId, full_name, private: isPrivate }, baseline);
    if (!result.ok) {
      const { status, code, detail } = result;
      return problem(status, code, detail, result.retry_after ? { retry_after: result.retry_after } : {});
    }
    return json(result.subscription, result.created ? 201 : 200);
  }
  if (subId && request.method === "DELETE") {
    return (await hub.unsubscribe(subId)) ? new Response(null, { status: 204 }) : problem(404, "not_found", "No such subscription");
  }
  return problem(404, "not_found", "No such endpoint");
}

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
