import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newTicketPayload, parseApiKey, signTicket, verifyTicket } from "../src/auth";
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
    expect(body.api_key).toMatch(new RegExp(`^wk1_${id}_[A-Za-z0-9_-]{43}$`));
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
    const parsed = (await parseApiKey(api_key))!;
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
  it("sends browsers at the root to the project page", async () => {
    // Not followed: here the follow-up would come back to this Worker.
    const res = await call("/", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://github.com/thepaul/watcheroni");
    expect((await call("/", { method: "POST" })).status).toBe(401);
  });

  it("publishes the client ID for the device flow", async () => {
    const meta = await (await call("/v1/meta")).json<Meta>();
    expect(meta.github?.client_id).toBe("Iv23test");
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
    const [, , secret] = api_key.match(/^wk1_(\d+)_(.+)$/)!;
    const other = `wk1_${nextAccount++}_${secret}`;
    expect((await call("/v1/keys", { headers: bearer(other) })).status).toBe(401);
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
    let last!: Response;
    for (let i = 0; i < 120; i++) {
      last = await call("/v1/keys", { headers: bearer(api_key) });
      expect(last.status).toBe(200);
    }
    expect(last.headers.get("RateLimit-Limit")).toBe("120");
    expect(last.headers.get("RateLimit-Remaining")).toBe("0");
    const limited = await call("/v1/keys", { headers: bearer(api_key) });
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
