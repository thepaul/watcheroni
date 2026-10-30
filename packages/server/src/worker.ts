// Prototype Worker: Account Durable Objects with hibernated WebSockets and
// the long-poll bridge described in DESIGN.md, behind real sign-in (login
// with a GitHub user token, API keys, WebSocket tickets), and RepoHub.
// GitHub webhooks are verified, normalised and sent to RepoHub, or to
// Installation for installation events; /v1 subscriptions check access
// with GitHub and subscribe RepoHub. A cron trigger has Control redeliver
// webhooks that failed.

import type { Account, AuthResult, Delivery, RateState } from "./account";
import { bearer, newApiKey, newKeyId, newTicketPayload, parseApiKey, secretsEqual, signTicket, verifyTicket } from "./auth";
import type { NewSubscription, PrBaseline } from "./repo-hub";
import { GITHUB_API_URL, GITHUB_WEB_URL, checkUserToken, refreshUserToken } from "./github";
import type { InstallationFact } from "./installation";
import type { Control } from "./control";
import {
  installUrl,
  createSubscription,
  deleteSubscription,
  verifySubscription,
  getSubscription,
  installationStub,
  listSubscriptions,
  repoHubStub,
} from "./subscriptions";
import pkg from "../package.json";
import { image } from "./images";
import { ipLimitKey } from "./ip";
import { landingPage, setupPage } from "./pages";
import { normalise } from "./webhook/normalise";
import { verifySignature } from "./webhook/signature";
import {
  INBOX_NAME,
  MAX_LIMIT,
  MAX_TTL_SECONDS,
  MAX_WAIT_SECONDS,
  PRIVATE_VERIFY_SECONDS,
  json,
  problem,
  readJson,
  withRetryAfter,
  type EventsPage,
  type DataValue,
  type LoginRequest,
  type LoginResponse,
  type Meta,
  type RefreshRequest,
  type ServerMessage,
  type TicketResponse,
  type WatchEvent,
} from "./protocol";

export { Account } from "./account";
export { RepoHub } from "./repo-hub";
export { Installation } from "./installation";
export { Control } from "./control";

const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;
const MAX_LABEL_LENGTH = 100;

type AccountStub = DurableObjectStub<Account>;

function accountStub(env: Env, id: number): AccountStub {
  return env.ACCOUNT.get(env.ACCOUNT.idFromName(`acct:${id}`));
}

function controlStub(env: Env): DurableObjectStub<Control> {
  return env.CONTROL.get(env.CONTROL.idFromName("control"));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const route = `${request.method} ${pathname}`;

    if (pathname === "/healthz") return new Response("ok");
    if (pathname === "/" && (request.method === "GET" || request.method === "HEAD")) return landingPage(installUrl(env));
    if (route === "GET /github/setup") return setupPage(url);
    const img = image(request, pathname);
    if (img) return img;
    if (route === "GET /v1/meta") return json(meta(env));
    if (route === "POST /github/webhook") return webhook(request, env);
    if (route === "POST /v1/login") return (await ipLimited(env.LOGIN_RATE_LIMIT, request)) ?? login(request, env);
    if (route === "POST /v1/github/refresh") return (await ipLimited(env.REFRESH_RATE_LIMIT, request)) ?? refresh(request, env);
    if (pathname.startsWith("/debug/")) return debug(request, url, env);

    const inboxMatch = pathname.match(/^\/v1\/inboxes\/([^/]+)(?:(\/[a-z]+)(?:\/([^/]+)(\/[a-z]+)?)?)?$/);
    const inbox = inboxMatch ? decodeURIComponent(inboxMatch[1]) : null;
    const itemId = inboxMatch?.[3] ? decodeURIComponent(inboxMatch[3]) : null;
    if (inbox !== null && !INBOX_NAME.test(inbox)) return problem(400, "invalid_request", "Bad inbox name");

    // A ticket stands in for the key on a WebSocket handshake, since
    // browsers can't set headers on one.
    const ticket = url.searchParams.get("ticket");
    if (inbox !== null && inboxMatch![2] === "/ws" && itemId === null && ticket !== null && request.method === "GET") {
      return connectWithTicket(request, env, inbox, ticket);
    }

    // A forged key stops here, before any Durable Object.
    const parsed = await parseApiKey(bearer(request) ?? "", env.API_KEY_SECRET);
    if (!parsed) return problem(401, "unauthorized", "Missing or malformed API key");
    const account = accountStub(env, parsed.accountId);
    const auth = await account.authenticate(parsed.hash);
    if (!auth.ok) return authFailure(auth);
    const caller: Caller = { account, accountId: parsed.accountId, keyId: auth.keyId };
    const rest = (inboxMatch?.[2] ?? "") + (itemId === null ? "" : "/{id}") + (inboxMatch?.[4] ?? "");
    const res = await api(request, url, env, caller, inbox, rest, itemId);
    return withRateHeaders(res, auth.rate);
  },

  // Every 10 minutes (production only; see wrangler.jsonc): redeliver
  // webhooks that failed. The work happens in Control, whose CPU limit is
  // far above a cron invocation's 10 ms.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const run = await controlStub(env).redeliver();
    console.log(`redelivery: ${JSON.stringify(run)}`);
  },
} satisfies ExportedHandler<Env>;

interface Caller {
  account: AccountStub;
  accountId: number;
  keyId: string;
}

// Everything under /v1 that needs an API key.
async function api(
  request: Request,
  url: URL,
  env: Env,
  { account, accountId, keyId }: Caller,
  inbox: string | null,
  rest: string,
  itemId: string | null,
): Promise<Response> {
  const { pathname } = url;
  if (pathname === "/v1/keys" && request.method === "GET") {
    return json({ keys: await account.listKeys() });
  }
  const keyMatch = pathname.match(/^\/v1\/keys\/([^/]+)$/);
  if (keyMatch && request.method === "DELETE") {
    const id = keyMatch[1] === "current" ? keyId : decodeURIComponent(keyMatch[1]);
    return (await account.revokeKey(id)) ? new Response(null, { status: 204 }) : problem(404, "not_found", "No such key");
  }

  if (inbox === null) return problem(404, "not_found", "No such endpoint");
  const name = inbox;
  switch (`${request.method} /v1/inboxes/{name}${rest}`) {
    case "PUT /v1/inboxes/{name}":
      return json(await account.ensureInbox(name));

    case "POST /v1/inboxes/{name}/subscriptions":
      return createSubscription(request, env, account, accountId, name);
    case "GET /v1/inboxes/{name}/subscriptions":
      return listSubscriptions(account, name);
    case "GET /v1/inboxes/{name}/subscriptions/{id}":
      return getSubscription(account, name, itemId!);
    case "DELETE /v1/inboxes/{name}/subscriptions/{id}":
      return deleteSubscription(env, account, name, itemId!);
    case "POST /v1/inboxes/{name}/subscriptions/{id}/verify":
      return verifySubscription(request, env, account, accountId, name, itemId!);

    case "GET /v1/inboxes/{name}/events":
      return longPoll(account, name, url, request.signal);

    case "POST /v1/inboxes/{name}/ack": {
      const body = await readJson<{ seq?: unknown }>(request);
      if (typeof body?.seq !== "number") return problem(400, "invalid_request", "Body must be {\"seq\": number}");
      const result = await account.ack(name, body.seq);
      return result ? json(result) : problem(404, "not_found", "No such inbox");
    }

    case "POST /v1/inboxes/{name}/ticket": {
      if (!env.TICKET_KEY) return problem(503, "unavailable", "WebSocket tickets aren't configured on this server");
      const ticket = await signTicket(newTicketPayload(accountId, name, keyId), env.TICKET_KEY);
      const wsUrl = new URL(`/v1/inboxes/${encodeURIComponent(name)}/ws`, url);
      wsUrl.protocol = url.protocol === "http:" ? "ws:" : "wss:";
      wsUrl.searchParams.set("ticket", ticket);
      return json({ ticket, url: wsUrl.toString() } satisfies TicketResponse);
    }

    // Clients that can set headers on the handshake may use the key directly.
    case "GET /v1/inboxes/{name}/ws":
      return connect(request, account, name, keyId);
  }
  return problem(404, "not_found", "No such endpoint");
}

function meta(env: Env): Meta {
  return {
    protocol: 1,
    server: `watcheroni/${pkg.version}`,
    features: ["ws", "longpoll", "repo_scope"],
    ...(env.GITHUB_CLIENT_ID
      ? {
          github: {
            client_id: env.GITHUB_CLIENT_ID,
            web_url: GITHUB_WEB_URL,
            api_url: GITHUB_API_URL,
            ...(env.GITHUB_APP_SLUG ? { app_slug: env.GITHUB_APP_SLUG, install_url: installUrl(env) } : {}),
          },
        }
      : {}),
    limits: { max_wait_seconds: MAX_WAIT_SECONDS, max_ttl_seconds: MAX_TTL_SECONDS, private_verify_seconds: PRIVATE_VERIFY_SECONDS },
  };
}

// POST /v1/login: check the user's GitHub token once, issue an API key,
// forget the token.
async function login(request: Request, env: Env): Promise<Response> {
  const body = await readJson<Partial<LoginRequest>>(request);
  if (typeof body?.github_token !== "string" || !body.github_token) {
    return problem(400, "invalid_request", "Body must include github_token");
  }
  if (body.label !== undefined && typeof body.label !== "string") {
    return problem(400, "invalid_request", "label must be a string");
  }
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.API_KEY_SECRET) {
    return problem(503, "unavailable", "Sign-in isn't configured on this server");
  }
  const check = await checkUserToken(env, body.github_token);
  if (!check.ok) {
    return check.reason === "invalid"
      ? problem(401, "github_token_invalid", "GitHub didn't recognise this token as one issued to this server's App")
      : withRetryAfter(problem(503, "unavailable", "Couldn't check the token with GitHub"), 30);
  }
  const { id, login } = check.user;
  const { key, hash } = await newApiKey(id, env.API_KEY_SECRET);
  const keyId = newKeyId();
  await accountStub(env, id).createKey(keyId, hash, body.label?.slice(0, MAX_LABEL_LENGTH) || null, login);
  return json({ api_key: key, key_id: keyId, account: { id, login } } satisfies LoginResponse);
}

// POST /v1/github/refresh: the stateless refresh proxy.
async function refresh(request: Request, env: Env): Promise<Response> {
  const body = await readJson<Partial<RefreshRequest>>(request);
  if (typeof body?.refresh_token !== "string" || !body.refresh_token) {
    return problem(400, "invalid_request", "Body must include refresh_token");
  }
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return problem(503, "unavailable", "Sign-in isn't configured on this server");
  }
  try {
    return await refreshUserToken(env, body.refresh_token);
  } catch {
    return withRetryAfter(problem(503, "unavailable", "Couldn't reach GitHub"), 30);
  }
}

// The Retry-After on their 429s. It must match the `period` of
// LOGIN_RATE_LIMIT and REFRESH_RATE_LIMIT in wrangler.jsonc (both
// environments).
const IP_LIMIT_PERIOD_SECONDS = 60;

// A 429 if the caller's IPv4 address or IPv6 /64 is over `limiter`'s
// limit, else null. For /v1/login and /v1/github/refresh, which need no
// API key but each cost a GitHub call with the App's client secret: a
// flood of them could get the App throttled by GitHub and stop everyone
// signing in. (wrangler dev and the tests simulate the bindings locally.)
//
// It fails open. Without the binding (a self-hosted config made before
// it existed), without CF-Connecting-IP (which Cloudflare always sets),
// or when the limiter itself fails, the request goes through. The limit
// protects GitHub's budget for the App, not access to anything: each
// request still needs a GitHub token or refresh token issued to this App,
// so failing closed would only turn a missing binding into the outage the
// limit is there to prevent.
async function ipLimited(limiter: RateLimit | undefined, request: Request): Promise<Response | null> {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!limiter || !ip) return null;
  try {
    if ((await limiter.limit({ key: ipLimitKey(ip) })).success) return null;
  } catch (e) {
    console.error("rate limiter failed", e);
    return null;
  }
  return withRetryAfter(problem(429, "rate_limited", "Too many sign-in requests from this address"), IP_LIMIT_PERIOD_SECONDS);
}

async function connectWithTicket(request: Request, env: Env, inbox: string, ticket: string): Promise<Response> {
  if (!isUpgrade(request)) return problem(426, "invalid_request", "Expected a WebSocket upgrade");
  const payload = await verifyTicket(ticket, [env.TICKET_KEY, env.TICKET_KEY_OLD]);
  if (!payload || payload.inbox !== inbox) return problem(401, "unauthorized", "Invalid or expired ticket");
  return connect(request, accountStub(env, payload.acct), inbox, payload.key, payload);
}

function connect(
  request: Request,
  account: AccountStub,
  inbox: string,
  keyId: string,
  ticket?: { nonce: string; exp: number },
): Promise<Response> | Response {
  if (!isUpgrade(request)) return problem(426, "invalid_request", "Expected a WebSocket upgrade");
  const target = new URL("https://account/ws");
  target.searchParams.set("inbox", inbox);
  target.searchParams.set("mode", "client");
  target.searchParams.set("key", keyId);
  if (ticket) {
    target.searchParams.set("nonce", ticket.nonce);
    target.searchParams.set("exp", String(ticket.exp));
  }
  return account.fetch(new Request(target, request));
}

// /debug: development routes behind DEBUG_TOKEN, and off when it isn't set.
// They stand in for login (minting a key without GitHub), for /v1
// subscriptions without the GitHub checks, and for RepoHub (injecting
// events), and show what Account, RepoHub, Installation and Control
// objects are doing.
async function debug(request: Request, url: URL, env: Env): Promise<Response> {
  const given = bearer(request);
  if (!env.DEBUG_TOKEN || !given || !(await secretsEqual(given, env.DEBUG_TOKEN))) {
    return problem(404, "not_found", "No such endpoint");
  }
  const repoRoute = url.pathname.match(/^\/debug\/repos\/(\d+)(?:\/subscriptions(?:\/([^/]+))?)?$/);
  if (repoRoute) return debugRepo(request, env, Number(repoRoute[1]), repoRoute[0].includes("/subscriptions"), repoRoute[2]);
  const instRoute = url.pathname.match(/^\/debug\/installations\/(\d+)$/);
  if (instRoute && request.method === "GET") return json(await installationStub(env, Number(instRoute[1])).stats());
  if (url.pathname === "/debug/control" && request.method === "GET") return json(await controlStub(env).stats());
  // One run of the redelivery cron job, now. It lists the App's
  // deliveries, wherever they went, and redelivers to the App's webhook
  // URL, which is production's even on the test server. So by default
  // it's a dry run, listing what it would redeliver; ?confirm=production
  // redelivers.
  if (url.pathname === "/debug/control/redeliver" && request.method === "POST") {
    const dryRun = url.searchParams.get("confirm") !== "production";
    return json(await controlStub(env).redeliver({ dryRun }));
  }

  const m = url.pathname.match(/^\/debug\/accounts\/(\d{1,15})(\/.*)$/);
  if (!m) return problem(404, "not_found", "No such endpoint");
  const accountId = Number(m[1]);
  const account = accountStub(env, accountId);
  const rest = m[2];

  if (rest === "/keys" && request.method === "POST") {
    if (!env.API_KEY_SECRET) return problem(503, "unavailable", "API_KEY_SECRET isn't set on this server");
    const body = (await readJson<{ label?: string; login?: string }>(request)) ?? {};
    const { key, hash } = await newApiKey(accountId, env.API_KEY_SECRET);
    const keyId = newKeyId();
    const login = body.login ?? `debug-${accountId}`;
    await account.createKey(keyId, hash, body.label ?? "debug", login);
    return json({ api_key: key, key_id: keyId, account: { id: accountId, login } } satisfies LoginResponse);
  }
  if (rest === "/stats" && request.method === "GET") {
    return json(await account.stats());
  }
  const inject = rest.match(/^\/inboxes\/([^/]+)\/events$/);
  if (inject && request.method === "POST") {
    const name = decodeURIComponent(inject[1]);
    if (!INBOX_NAME.test(name)) return problem(400, "invalid_request", "Bad inbox name");
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
  return problem(404, "not_found", "No such endpoint");
}

function authFailure(auth: Exclude<AuthResult, { ok: true }>): Response {
  if (auth.reason === "rate_limited") {
    const res = problem(429, "rate_limited", "Too many requests for this account");
    return withRetryAfter(withRateHeaders(res, auth.rate), auth.retryAfter);
  }
  return problem(401, "unauthorized", "Unknown or revoked API key");
}

// RateLimit-* on every authenticated response except a WebSocket
// handshake, whose headers can't be changed.
function withRateHeaders(res: Response, rate: RateState): Response {
  if (res.status === 101) return res;
  res = new Response(res.body, res);
  res.headers.set("RateLimit-Limit", String(rate.limit));
  res.headers.set("RateLimit-Remaining", String(rate.remaining));
  res.headers.set("RateLimit-Reset", String(rate.reset));
  return res;
}

function isUpgrade(request: Request): boolean {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

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
  // The user revoked the App's authorization on GitHub: their GitHub
  // tokens are dead, and so are their watcheroni keys.
  if (event === "github_app_authorization") {
    const user = (payload as { action?: string; sender?: { id?: number } }).sender?.id;
    const revoked = payload.action === "revoked" && typeof user === "number" ? await accountStub(env, user).revokeAllKeys() : 0;
    return json({ events: [], revoked_keys: revoked }, 202);
  }
  if (event === "installation" || event === "installation_repositories") {
    const fact = installationFact(payload);
    const installation = fact ? await installationStub(env, fact.id).onEvent(fact, delivery) : null;
    return json({ events: [], installation }, 202);
  }
  const events = normalise(event, delivery, payload, new Date().toISOString());
  // Deliveries that normalise to nothing never reach a Durable Object.
  const repoId = events[0]?.repo?.id;
  const installationId = (payload as { installation?: { id?: unknown } }).installation?.id;
  const ingest = repoId
    ? await repoHubStub(env, repoId).ingest(delivery, events, typeof installationId === "number" ? installationId : undefined)
    : null;
  return json({ events, ingest }, 202);
}

// The parts of an `installation` or `installation_repositories` payload
// that Installation needs.
function installationFact(payload: {
  action?: string;
  installation?: { id?: number; account?: { login?: string; type?: string }; repository_selection?: string };
  repositories_removed?: { id?: number }[];
}): InstallationFact | null {
  const id = payload.installation?.id;
  if (typeof id !== "number" || typeof payload.action !== "string") return null;
  const account = payload.installation?.account;
  return {
    id,
    action: payload.action,
    account: account?.login ? { login: account.login, type: account.type ?? "" } : null,
    repository_selection: payload.installation?.repository_selection ?? null,
    repos_removed: (payload.repositories_removed ?? []).flatMap((r) => (typeof r.id === "number" ? [r.id] : [])),
  };
}

// Subscriptions straight into RepoHub, with no GitHub checks, for tests
// and for poking at a RepoHub:
//   GET    /debug/repos/{id}                     RepoHub's state
//   POST   /debug/repos/{id}/subscriptions       {account, inbox, pr, kinds?, base?, author?, ignore?, full_name?, installation_id?, baseline?}
//   DELETE /debug/repos/{id}/subscriptions/{sub}
async function debugRepo(request: Request, env: Env, repoId: number, subs: boolean, subId?: string): Promise<Response> {
  const hub = repoHubStub(env, repoId);
  if (!subs && request.method === "GET") return json(await hub.stats());
  if (subs && !subId && request.method === "POST") {
    const body = await readJson<NewSubscription & { full_name?: string; private?: boolean; installation_id?: number; baseline?: PrBaseline }>(request);
    if (!body || typeof body.inbox !== "string" || !INBOX_NAME.test(body.inbox)) {
      return problem(400, "invalid_request", "Body needs account, inbox and pr");
    }
    const { full_name = `repo-${repoId}`, private: isPrivate, installation_id, baseline, ...sub } = body;
    const repo = { id: repoId, full_name, private: isPrivate, installation_id };
    const result = await hub.subscribe({ ...sub, pr: sub.pr ?? null }, repo, baseline);
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
  account: AccountStub,
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

function intParam(url: URL, key: string): number | null {
  const v = url.searchParams.get(key);
  if (v === null || !/^\d+$/.test(v)) return null;
  return Number(v);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}
