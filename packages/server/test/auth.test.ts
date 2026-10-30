import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { base64url, newApiKey, newTicketPayload, parseApiKey, signTicket, verifyTicket } from "../src/auth";
import { landingPage } from "../src/pages";
import worker from "../src/worker";
import type { KeysResponse, LoginResponse, Meta, TicketResponse } from "../src/protocol";

const BASE = "https://watcheroni.test";
const DEBUG = { Authorization: "Bearer test-debug-token" };

// Each test gets its own account, so rate limits and keys don't leak
// between tests.
let nextAccount = 2000;

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(`${BASE}${path}`, init);
}

function post(path: string, body: unknown, headers: HeadersInit = {}): Promise<Response> {
  return call(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

async function mintKey(accountId = nextAccount++): Promise<LoginResponse> {
  return (await post(`/debug/accounts/${accountId}/keys`, {}, DEBUG)).json();
}

const accountStub = (id: number) => env.ACCOUNT.get(env.ACCOUNT.idFromName(`acct:${id}`));
const randomSecret = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
const noAccount = () => {
  throw new Error("no Account objects here");
};
// The test env, but with an ACCOUNT binding that throws if touched.
const untouchable = () => ({ ...env, ACCOUNT: { get: noAccount, idFromName: noAccount, idFromString: noAccount } }) as unknown as Env;

// Every row of every table in an account's storage, by table.
function storedRows(accountId: number): Promise<Record<string, unknown[]>> {
  return runInDurableObject(accountStub(accountId), (_, state) => {
    const rows: Record<string, unknown[]> = {};
    for (const { name } of state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")) {
      if (name.startsWith("_cf_") || name.startsWith("sqlite_")) continue;
      rows[name] = state.storage.sql.exec(`SELECT * FROM "${name}"`).toArray();
    }
    return rows;
  });
}

// Stands in for GitHub, recording the requests the server made. Bodies are
// read here, since the request belongs to the Worker's I/O context.
type GitHubHandler = (req: Request) => Response | Promise<Response>;
function mockGitHub(handlers: Record<string, GitHubHandler>) {
  const seen: { headers: Headers; body: unknown }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    seen.push({ headers: req.headers, body: await req.clone().json().catch(() => null) });
    const url = new URL(req.url);
    const handler = handlers[`${req.method} ${url.origin}${url.pathname}`];
    if (!handler) throw new Error(`unexpected fetch ${req.method} ${req.url}`);
    return handler(req);
  });
  return seen;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const CHECK_URL = "POST https://api.github.com/applications/Iv23test/token";

function tokenOk(user: { id: number; login: string }, clientId = "Iv23test"): GitHubHandler {
  return () => Response.json({ id: 1, token: "ghu_x", app: { client_id: clientId, name: "watcheroni" }, user });
}

describe("login", () => {
  it("checks the token with GitHub and issues a key", async () => {
    const id = nextAccount++;
    const seen = mockGitHub({ [CHECK_URL]: tokenOk({ id, login: "octocat" }) });
    const res = await post("/v1/login", { github_token: "ghu_good", label: "laptop" });
    expect(res.status).toBe(200);
    const body = await res.json<LoginResponse>();
    expect(body.account).toEqual({ id, login: "octocat" });
    expect(body.api_key).toMatch(new RegExp(`^wk2_${id}_[A-Za-z0-9_-]{43}_[A-Za-z0-9_-]{43}$`));
    expect(body.key_id).toMatch(/^key_[0-9A-Z]{26}$/);

    // The server asked with the App's credentials and the user's token.
    expect(seen).toHaveLength(1);
    expect(seen[0].headers.get("Authorization")).toBe(`Basic ${btoa("Iv23test:test-client-secret")}`);
    expect(seen[0].body).toEqual({ access_token: "ghu_good" });
    vi.restoreAllMocks();

    // The key works, and lands in that user's own account.
    const keys = await (await call("/v1/keys", { headers: bearer(body.api_key) })).json<KeysResponse>();
    expect(keys.keys).toEqual([
      { id: body.key_id, label: "laptop", created_at: expect.any(String), last_used_at: expect.any(String) },
    ]);
  });

  it("rejects a token GitHub doesn't know as this App's", async () => {
    mockGitHub({ [CHECK_URL]: () => Response.json({ message: "Not Found" }, { status: 404 }) });
    const res = await post("/v1/login", { github_token: "ghp_personal" });
    expect(res.status).toBe(401);
    expect((await res.json<{ code: string }>()).code).toBe("github_token_invalid");
  });

  it("rejects a token issued to a different App", async () => {
    mockGitHub({ [CHECK_URL]: tokenOk({ id: nextAccount++, login: "octocat" }, "Iv23someoneelse") });
    const res = await post("/v1/login", { github_token: "ghu_other_app" });
    expect(res.status).toBe(401);
    expect((await res.json<{ code: string }>()).code).toBe("github_token_invalid");
  });

  it("answers 503 when GitHub can't be asked", async () => {
    mockGitHub({ [CHECK_URL]: () => new Response("bad credentials", { status: 401 }) });
    const res = await post("/v1/login", { github_token: "ghu_good" });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("rejects a malformed body without calling GitHub", async () => {
    const seen = mockGitHub({});
    expect((await post("/v1/login", {})).status).toBe(400);
    expect((await post("/v1/login", { github_token: "ghu_x", label: 3 })).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("stores only a hash of the key, and never the GitHub token", async () => {
    const id = nextAccount++;
    mockGitHub({ [CHECK_URL]: tokenOk({ id, login: "hashcheck" }) });
    const { api_key } = await (await post("/v1/login", { github_token: "ghu_secret_token" })).json<LoginResponse>();
    const parsed = (await parseApiKey(api_key, env.API_KEY_SECRET))!;
    const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName(`acct:${id}`));
    const dump = await runInDurableObject(stub, (_, state) => {
      const rows: unknown[] = [];
      for (const { name } of state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")) {
        if (name.startsWith("_cf_") || name.startsWith("sqlite_")) continue;
        rows.push(...state.storage.sql.exec(`SELECT * FROM "${name}"`).toArray());
      }
      return rows;
    });
    const text = JSON.stringify(dump, (_, v) => (v instanceof ArrayBuffer ? [...new Uint8Array(v)] : v));
    expect(text).not.toContain("ghu_secret_token");
    expect(text).not.toContain(api_key.split("_").slice(2).join("_"));
    expect(text).toContain(JSON.stringify([...new Uint8Array(parsed.hash)]));
  });
});

describe("meta", () => {
  it("serves a landing page at the root", async () => {
    const res = await call("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    // Nothing from another host, and no scripts at all.
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("set-cookie")).toBeNull();
    const html = await res.text();
    expect(html).toContain('href="https://github.com/apps/watcheroni/installations/new"');
    expect(html).toContain("npx watcheroni login");
    expect(html).toContain("npx watcheroni wait");
    expect(html).toContain("watcheroni exec -- <var>command</var>");
    expect(html).toContain("is still open. Run `watcheroni wait` again to keep watching.");
    expect(html).not.toMatch(/<script|src="http/);
    expect((await call("/", { method: "HEAD" })).status).toBe(200);
    expect((await call("/", { method: "POST" })).status).toBe(401);
    // A server with no App yet (GITHUB_APP_SLUG empty) links nowhere.
    expect(await landingPage(undefined).text()).not.toContain("/installations/new");
  });

  it("serves the logo and favicons the pages link to", async () => {
    const html = await (await call("/")).text();
    for (const [path, type] of [
      ["/favicon.ico", "image/x-icon"],
      ["/favicon.svg", "image/svg+xml"],
      ["/apple-touch-icon.png", "image/png"],
      ["/logo.svg", "image/svg+xml"],
      ["/logo-dark.svg", "image/svg+xml"],
    ]) {
      expect(html).toMatch(new RegExp(`(href|src|srcset)="${path}"`));
      const res = await call(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(type);
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(500);
    }
    expect(await (await call("/logo.svg")).text()).toMatch(/^<svg /);
    expect((await call("/favicon.ico", { method: "HEAD" })).status).toBe(200);
  });

  it("has a page for GitHub to send people to after installing", async () => {
    const res = await call("/github/setup?installation_id=1&setup_action=install");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    const html = await res.text();
    expect(html).toContain("watcheroni is installed");
    expect(html).toContain("npx watcheroni login");
    expect(html).toContain('href="/"');
    expect(html).not.toContain("<script");
    const requested = await (await call("/github/setup?setup_action=request&installation_id=<script>")).text();
    expect(requested).toContain("Installation requested");
    expect(requested).not.toContain("<script>");
  });

  it("publishes the client ID for the device flow", async () => {
    const meta = await (await call("/v1/meta")).json<Meta>();
    expect(meta.github?.client_id).toBe("Iv23test");
    expect(meta.server).toMatch(/^watcheroni\/\d+\.\d+\.\d+$/);
  });
});

describe("API keys", () => {
  it("rejects missing, malformed and unknown keys", async () => {
    expect((await call("/v1/keys")).status).toBe(401);
    expect((await call("/v1/keys", { headers: bearer("not-a-key") })).status).toBe(401);
    const { api_key } = await mintKey();
    const forged = api_key.slice(0, -4) + (api_key.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect((await call("/v1/keys", { headers: bearer(forged) })).status).toBe(401);
  });

  it("can't be used against another account", async () => {
    const { api_key } = await mintKey();
    const [, , secret, tag] = api_key.match(/^wk2_(\d+)_(.{43})_(.{43})$/)!;
    const other = `wk2_${nextAccount++}_${secret}_${tag}`;
    expect((await call("/v1/keys", { headers: bearer(other) })).status).toBe(401);
  });

  it("turns away keys without a valid tag before any Account object", async () => {
    const { api_key } = await mintKey();
    const [, id, secret, tag] = api_key.match(/^wk2_(\d+)_(.{43})_(.{43})$/)!;
    const made = `wk2_${nextAccount++}_${randomSecret()}`;
    // The tag's last character carries two unused bits; flipping one
    // decodes to the same bytes, but isn't the tag the server wrote.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const respelt = tag.slice(0, -1) + alphabet[alphabet.indexOf(tag.at(-1)!) ^ 1];
    for (const key of [
      `${made}_${tag}`,
      `${made}_${"A".repeat(43)}`,
      made,
      `wk2_${id}_${secret}_${tag.slice(0, -4)}${tag.endsWith("AAAA") ? "BBBB" : "AAAA"}`,
      `wk2_${id}_${randomSecret()}_${tag}`,
      `wk2_${id}_${secret}_${respelt}`,
      // Keys from before tags aren't accepted at all.
      `wk1_${id}_${secret}`,
      `wk1_${id}_${secret}_${tag}`,
    ]) {
      const res = await worker.fetch(new Request(`${BASE}/v1/keys`, { headers: bearer(key) }), untouchable());
      expect(res.status, key).toBe(401);
    }
    // And the real key gets as far as the Account object.
    await expect(worker.fetch(new Request(`${BASE}/v1/keys`, { headers: bearer(api_key) }), untouchable())).rejects.toThrow(/no Account/);
  });

  it("leaves nothing in storage for a key the Account object doesn't know", async () => {
    // A correctly tagged key for an account that was never made.
    const madeUp = nextAccount++;
    const { key } = await newApiKey(madeUp, env.API_KEY_SECRET);
    expect((await call("/v1/keys", { headers: bearer(key) })).status).toBe(401);
    expect(await storedRows(madeUp)).toEqual({});

    // Nor does a wrong key for a real account, even in a new instance of
    // its object.
    const real = nextAccount++;
    await mintKey(real);
    await evictDurableObject(accountStub(real));
    const before = await storedRows(real);
    expect(before.keys).toHaveLength(1);
    await evictDurableObject(accountStub(real));
    const { key: unknown } = await newApiKey(real, env.API_KEY_SECRET);
    expect((await call("/v1/keys", { headers: bearer(unknown) })).status).toBe(401);
    expect(await storedRows(real)).toEqual(before);
  });

  it("aren't issued or accepted without API_KEY_SECRET", async () => {
    const accountId = nextAccount++;
    const { api_key } = await mintKey(accountId);
    const unset = { ...env, API_KEY_SECRET: undefined } as unknown as Env;
    const send = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${BASE}${path}`, init), unset);

    const seen = mockGitHub({});
    const login = await send("/v1/login", { method: "POST", body: JSON.stringify({ github_token: "ghu_x" }) });
    expect(login.status).toBe(503);
    expect(seen).toHaveLength(0);
    expect((await send(`/debug/accounts/${accountId}/keys`, { method: "POST", headers: DEBUG })).status).toBe(503);
    // A real key is turned away before any Account object.
    const res = await worker.fetch(new Request(`${BASE}/v1/keys`, { headers: bearer(api_key) }), { ...untouchable(), API_KEY_SECRET: undefined } as unknown as Env);
    expect(res.status).toBe(401);
  });

  it("lists keys and revokes them by ID or as current", async () => {
    const accountId = nextAccount++;
    const a = await mintKey(accountId);
    const b = await mintKey(accountId);
    const c = await mintKey(accountId);
    const list = async (key: string) =>
      (await (await call("/v1/keys", { headers: bearer(key) })).json<KeysResponse>()).keys.map((k) => k.id);
    expect(await list(a.api_key)).toEqual([a.key_id, b.key_id, c.key_id]);

    expect((await call(`/v1/keys/${b.key_id}`, { method: "DELETE", headers: bearer(a.api_key) })).status).toBe(204);
    expect((await call("/v1/keys", { headers: bearer(b.api_key) })).status).toBe(401);
    expect((await call(`/v1/keys/${b.key_id}`, { method: "DELETE", headers: bearer(a.api_key) })).status).toBe(404);

    expect((await call("/v1/keys/current", { method: "DELETE", headers: bearer(c.api_key) })).status).toBe(204);
    expect((await call("/v1/keys", { headers: bearer(c.api_key) })).status).toBe(401);
    expect(await list(a.api_key)).toEqual([a.key_id]);
  });

  it("hangs up a revoked key's WebSockets", async () => {
    const { api_key, key_id } = await mintKey();
    const res = await call("/v1/inboxes/revoke-me/ws", { headers: { ...bearer(api_key), Upgrade: "websocket" } });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const closed = new Promise<number>((resolve) => ws.addEventListener("close", (ev) => resolve(ev.code)));
    ws.accept();
    await call(`/v1/keys/${key_id}`, { method: "DELETE", headers: bearer(api_key) });
    expect(await closed).toBe(4001);
  });
});

describe("rate limit", () => {
  it("allows 120 requests a minute per account, then 429 with Retry-After", async () => {
    const { api_key } = await mintKey();
    // The bucket refills 2 tokens a second while the loop runs, so on a
    // busy machine a few more than 120 get through.
    let ok = 0;
    let last!: Response;
    let limited!: Response;
    for (;;) {
      const res = await call("/v1/keys", { headers: bearer(api_key) });
      if (res.status !== 200) {
        limited = res;
        break;
      }
      last = res;
      ok++;
    }
    expect(ok).toBeGreaterThanOrEqual(120);
    expect(ok).toBeLessThan(140);
    expect(last.headers.get("RateLimit-Limit")).toBe("120");
    expect(Number(last.headers.get("RateLimit-Remaining"))).toBeLessThanOrEqual(1);
    expect(limited.status).toBe(429);
    expect((await limited.json<{ code: string }>()).code).toBe("rate_limited");
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);

    // Another account has its own budget.
    const other = await mintKey();
    expect((await call("/v1/keys", { headers: bearer(other.api_key) })).status).toBe(200);
  });
});

describe("refresh proxy", () => {
  const REFRESH_URL = "POST https://github.com/login/oauth/access_token";

  it("adds the client secret and passes GitHub's answer through", async () => {
    const answer = { access_token: "ghu_new", expires_in: 28800, refresh_token: "ghr_new", token_type: "bearer" };
    const seen = mockGitHub({ [REFRESH_URL]: () => Response.json(answer) });
    const res = await post("/v1/github/refresh", { refresh_token: "ghr_old" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(answer);
    expect(seen[0].body).toEqual({
      client_id: "Iv23test",
      client_secret: "test-client-secret",
      grant_type: "refresh_token",
      refresh_token: "ghr_old",
    });
  });

  it("passes GitHub's errors through too", async () => {
    const answer = { error: "bad_refresh_token", error_description: "The refresh token passed is incorrect or expired." };
    mockGitHub({ [REFRESH_URL]: () => Response.json(answer) });
    expect(await (await post("/v1/github/refresh", { refresh_token: "ghr_bad" })).json()).toEqual(answer);
  });

  it("needs a refresh token", async () => {
    const seen = mockGitHub({});
    expect((await post("/v1/github/refresh", {})).status).toBe(400);
    expect(seen).toHaveLength(0);
  });
});

describe("per-IP limit on sign-in", () => {
  const REFRESH_URL = "POST https://github.com/login/oauth/access_token";
  // Each test gets its own addresses, so their counts don't leak.
  let nextIp = 1;
  const newIp = () => `203.0.113.${nextIp++}`;

  // Posts from `ip` until the limit answers 429, and returns that answer.
  // The limiter's windows are aligned to the clock, so one may roll over
  // part way: hence up to two windows' worth.
  async function untilLimited(path: string, body: unknown, ip: string): Promise<{ res: Response; ok: number }> {
    let ok = 0;
    for (let i = 0; i < 21; i++) {
      const res = await post(path, body, { "CF-Connecting-IP": ip });
      if (res.status === 429) return { res, ok };
      ok++;
    }
    throw new Error(`${path} never answered 429`);
  }

  it("answers /v1/login with 429 and Retry-After past 10 a minute, without calling GitHub", async () => {
    const id = nextAccount++;
    const seen = mockGitHub({ [CHECK_URL]: tokenOk({ id, login: "octocat" }) });
    const ip = newIp();
    const { res, ok } = await untilLimited("/v1/login", { github_token: "ghu_good" }, ip);
    expect(ok).toBeGreaterThanOrEqual(10);
    expect(seen).toHaveLength(ok);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(await res.json()).toMatchObject({ status: 429, code: "rate_limited" });

    // Another address has its own count, and a request with no
    // CF-Connecting-IP (which Cloudflare always sets) isn't limited.
    expect((await post("/v1/login", { github_token: "ghu_good" }, { "CF-Connecting-IP": newIp() })).status).toBe(200);
    expect((await post("/v1/login", { github_token: "ghu_good" })).status).toBe(200);
  });

  it("counts IPv6 addresses by their /64", async () => {
    const id = nextAccount++;
    mockGitHub({ [CHECK_URL]: tokenOk({ id, login: "octocat" }) });
    // Every request from a different address in 2001:db8:0:1::/64,
    // written every which way.
    const sameSlash64 = (i: number) => (i % 2 ? `2001:db8:0:1::${i.toString(16)}` : `2001:DB8:0000:0001:0:0:0:${i.toString(16)}`);
    let limited = false;
    for (let i = 1; i <= 21 && !limited; i++) {
      limited = (await post("/v1/login", { github_token: "ghu_good" }, { "CF-Connecting-IP": sameSlash64(i) })).status === 429;
    }
    expect(limited).toBe(true);
    // A neighbouring /64 has its own count.
    expect((await post("/v1/login", { github_token: "ghu_good" }, { "CF-Connecting-IP": "2001:db8:0:2::1" })).status).toBe(200);
  });

  it("limits /v1/github/refresh separately from /v1/login", async () => {
    const id = nextAccount++;
    mockGitHub({ [REFRESH_URL]: () => Response.json({ access_token: "ghu_new" }), [CHECK_URL]: tokenOk({ id, login: "octocat" }) });
    const ip = newIp();
    const { res } = await untilLimited("/v1/github/refresh", { refresh_token: "ghr_old" }, ip);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(await res.json()).toMatchObject({ status: 429, code: "rate_limited" });
    expect((await post("/v1/login", { github_token: "ghu_good" }, { "CF-Connecting-IP": ip })).status).toBe(200);
  });

  it("lets requests through when the binding is missing or fails", async () => {
    const id = nextAccount++;
    mockGitHub({ [CHECK_URL]: tokenOk({ id, login: "octocat" }) });
    const send = (e: Env) =>
      worker.fetch(
        new Request(`${BASE}/v1/login`, {
          method: "POST",
          headers: { "content-type": "application/json", "CF-Connecting-IP": newIp() },
          body: JSON.stringify({ github_token: "ghu_good" }),
        }),
        e,
      );
    const missing = { ...env, LOGIN_RATE_LIMIT: undefined } as unknown as Env;
    for (let i = 0; i < 12; i++) expect((await send(missing)).status).toBe(200);
    const broken = { ...env, LOGIN_RATE_LIMIT: { limit: () => Promise.reject(new Error("down")) } } as Env;
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await send(broken)).status).toBe(200);
    const full = { ...env, LOGIN_RATE_LIMIT: { limit: async () => ({ success: false }) } } as Env;
    expect((await send(full)).status).toBe(429);
  });
});

describe("tickets", () => {
  async function ticketFor(key: string, inbox: string): Promise<TicketResponse> {
    const res = await call(`/v1/inboxes/${inbox}/ticket`, { method: "POST", headers: bearer(key) });
    expect(res.status).toBe(200);
    return res.json();
  }

  function upgrade(url: string): Promise<Response> {
    return exports.default.fetch(url.replace(/^wss?:/, "https:"), { headers: { Upgrade: "websocket" } });
  }

  async function ready(res: Response): Promise<void> {
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const got = new Promise<{ type: string }>((resolve) => ws.addEventListener("message", (ev) => resolve(JSON.parse(String(ev.data)))));
    ws.accept();
    ws.send(JSON.stringify({ type: "hello" }));
    expect((await got).type).toBe("ready");
    ws.close(1000);
  }

  it("lets a WebSocket connect once", async () => {
    const { api_key } = await mintKey();
    const { ticket, url } = await ticketFor(api_key, "tix");
    expect(ticket).toMatch(/^wt1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(url).toBe(`wss://watcheroni.test/v1/inboxes/tix/ws?ticket=${ticket}`);
    await ready(await upgrade(url));
    // Single use.
    expect((await upgrade(url)).status).toBe(401);
  });

  it("isn't used up by a request that isn't an upgrade", async () => {
    const { api_key } = await mintKey();
    const { url } = await ticketFor(api_key, "tix");
    expect((await call(new URL(url.replace(/^wss:/, "https:")).pathname + new URL(url).search)).status).toBe(426);
    await ready(await upgrade(url));
  });

  it("works only for the inbox it names", async () => {
    const { api_key } = await mintKey();
    const { ticket } = await ticketFor(api_key, "one");
    expect((await upgrade(`${BASE}/v1/inboxes/two/ws?ticket=${ticket}`)).status).toBe(401);
  });

  it("expires after 60 seconds", async () => {
    const accountId = nextAccount++;
    const { key_id } = await mintKey(accountId);
    const stale = newTicketPayload(accountId, "tix", key_id, Date.now() - 61_000);
    const ticket = await signTicket(stale, env.TICKET_KEY);
    expect((await upgrade(`${BASE}/v1/inboxes/tix/ws?ticket=${ticket}`)).status).toBe(401);

    const fresh = newTicketPayload(accountId, "tix", key_id, Date.now() - 50_000);
    await ready(await upgrade(`${BASE}/v1/inboxes/tix/ws?ticket=${await signTicket(fresh, env.TICKET_KEY)}`));
  });

  it("accepts the old key during rotation, and no other", async () => {
    const accountId = nextAccount++;
    const { key_id } = await mintKey(accountId);
    const sign = (secret: string) => signTicket(newTicketPayload(accountId, "tix", key_id), secret);
    await ready(await upgrade(`${BASE}/v1/inboxes/tix/ws?ticket=${await sign(env.TICKET_KEY_OLD)}`));
    expect((await upgrade(`${BASE}/v1/inboxes/tix/ws?ticket=${await sign("some-other-key")}`)).status).toBe(401);
  });

  it("stops working when its key is revoked", async () => {
    const { api_key, key_id } = await mintKey();
    const { url } = await ticketFor(api_key, "tix");
    await call(`/v1/keys/${key_id}`, { method: "DELETE", headers: bearer(api_key) });
    expect((await upgrade(url)).status).toBe(401);
  });

  it("rejects tampered tickets", async () => {
    const payload = newTicketPayload(1, "tix", "key_x");
    const ticket = await signTicket(payload, "k");
    const [v, body, mac] = ticket.split(".");
    const other = btoa(JSON.stringify({ ...payload, acct: 2 })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await verifyTicket(ticket, ["k"])).toEqual(payload);
    expect(await verifyTicket(`${v}.${other}.${mac}`, ["k"])).toBeNull();
    expect(await verifyTicket(`${v}.${body}.${mac.slice(0, -2)}`, ["k"])).toBeNull();
    expect(await verifyTicket(`wt2.${body}.${mac}`, ["k"])).toBeNull();
    expect(await verifyTicket(ticket, [undefined, ""])).toBeNull();
  });
});

describe("debug routes", () => {
  it("are hidden without DEBUG_TOKEN", async () => {
    expect((await post("/debug/accounts/1/keys", {})).status).toBe(404);
    expect((await post("/debug/accounts/1/keys", {}, bearer("wrong"))).status).toBe(404);
  });
});
