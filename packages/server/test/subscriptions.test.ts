import examples from "@octokit/webhooks-examples/api.github.com/index.json";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appJwt } from "../src/app";
import { Installation } from "../src/installation";
import type { LoginResponse, Meta, SubscriptionInfo, SubscriptionsResponse, WatchEvent } from "../src/protocol";
import type { RepoHubStats } from "../src/repo-hub";
import { sign } from "../src/webhook/signature";

const BASE = "https://watcheroni.test";
const DEBUG = { Authorization: "Bearer test-debug-token" };
const SHA = "c".repeat(40);

let counter = 0;
const fresh = () => 800_000_000 + Math.floor(Math.random() * 1_000_000) * 100 + counter++;

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(`${BASE}${path}`, init);
}

// A signed-in account with an inbox called `box`.
async function signedIn(accountId = fresh()): Promise<{ id: number; key: string; auth: Record<string, string> }> {
  const res = await call(`/debug/accounts/${accountId}/keys`, { method: "POST", headers: DEBUG, body: "{}" });
  const { api_key } = await res.json<LoginResponse>();
  const auth = { Authorization: `Bearer ${api_key}` };
  expect((await call("/v1/inboxes/box", { method: "PUT", headers: auth })).status).toBe(200);
  return { id: accountId, key: api_key, auth };
}

function subscribe(auth: Record<string, string>, body: unknown, headers: Record<string, string> = {}, inbox = "box"): Promise<Response> {
  return call(`/v1/inboxes/${inbox}/subscriptions`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// ---- A stand-in for GitHub -------------------------------------------

interface FakeRepo {
  owner: string;
  name: string;
  id: number;
  private?: boolean;
  installation: number | null;
  prs: Record<number, { state?: "open" | "closed"; merged?: boolean; mergeable?: boolean | null; base?: string; author?: string }>;
  // User IDs whose tokens can read it (private repos).
  readers?: number[];
}

interface FakeGitHub {
  repos: FakeRepo[];
  // User tokens issued to this App, and whose they are.
  users?: Record<string, { id: number; login: string }>;
  suspended?: number[];
}

interface Seen {
  method: string;
  path: string;
  auth: string | null;
}

function newRepo(o: Partial<FakeRepo> = {}): FakeRepo {
  const id = fresh();
  return { owner: "octo", name: `widgets-${id}`, id, installation: fresh(), prs: { 7: { state: "open", mergeable: true } }, ...o };
}

const fullName = (r: FakeRepo) => `${r.owner}/${r.name}`;

function mockGitHub(gh: FakeGitHub): Seen[] {
  const seen: Seen[] = [];
  let minted = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const auth = req.headers.get("Authorization");
    seen.push({ method: req.method, path: url.pathname, auth });
    if (url.origin !== "https://api.github.com") throw new Error(`unexpected fetch ${req.url}`);
    const notFound = () => Response.json({ message: "Not Found" }, { status: 404 });
    const bearer = auth?.replace(/^Bearer /, "") ?? "";
    const isJwt = bearer.split(".").length === 3;
    const isInstallationToken = (r: FakeRepo) => bearer === `ghs_${r.installation}`;
    let m: RegExpMatchArray | null;

    if (req.method === "POST" && url.pathname === "/applications/Iv23test/token") {
      const { access_token } = (await req.json()) as { access_token: string };
      const user = gh.users?.[access_token];
      return user ? Response.json({ app: { client_id: "Iv23test" }, user }) : notFound();
    }
    if (req.method === "POST" && (m = url.pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/))) {
      if (!isJwt) return Response.json({}, { status: 401 });
      const id = Number(m[1]);
      if (gh.suspended?.includes(id)) return Response.json({ message: "suspended" }, { status: 403 });
      if (!gh.repos.some((r) => r.installation === id)) return notFound();
      minted++;
      return Response.json({ token: `ghs_${id}`, expires_at: new Date(Date.now() + 3600_000).toISOString(), n: minted }, { status: 201 });
    }
    if (req.method !== "GET") throw new Error(`unexpected fetch ${req.method} ${req.url}`);
    const repo = gh.repos.find((r) => url.pathname.startsWith(`/repos/${fullName(r)}/`) || url.pathname === `/repos/${fullName(r)}`);
    if (!repo) return notFound();
    const rest = url.pathname.slice(`/repos/${fullName(repo)}`.length);
    if (rest === "/installation") {
      if (!isJwt) return Response.json({}, { status: 401 });
      return repo.installation ? Response.json({ id: repo.installation, account: { login: repo.owner } }) : notFound();
    }
    const user = Object.entries(gh.users ?? {}).find(([token]) => token === bearer)?.[1];
    const canRead = isInstallationToken(repo) || (user && (!repo.private || repo.readers?.includes(user.id)));
    if (!canRead) return notFound();
    if (rest === "") return Response.json({ id: repo.id, full_name: fullName(repo), private: !!repo.private });
    if (rest === "/pulls") {
      if (url.searchParams.get("state") !== "open") throw new Error(`unexpected list ${req.url}`);
      return Response.json(Object.entries(repo.prs).filter(([, pr]) => (pr.state ?? "open") === "open").map(([n, pr]) => ({
        number: Number(n),
        state: "open",
        draft: false,
        head: { sha: SHA },
        base: { ref: pr.base ?? "main" },
        user: { login: pr.author ?? "someone" },
      })));
    }
    if ((m = rest.match(/^\/pulls\/(\d+)$/))) {
      const pr = repo.prs[Number(m[1])];
      if (!pr) return notFound();
      return Response.json({
        number: Number(m[1]),
        state: pr.state ?? "open",
        merged: !!pr.merged,
        draft: false,
        mergeable: pr.mergeable ?? null,
        head: { sha: SHA },
        base: { ref: "main" },
      });
    }
    return notFound();
  });
  return seen;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const hubStats = (repo: number): Promise<RepoHubStats> => env.REPO_HUB.get(env.REPO_HUB.idFromName(`repo:${repo}`)).stats();
const installation = (id: number) => env.INSTALLATION.get(env.INSTALLATION.idFromName(`inst:${id}`));

async function inboxEvents(account: number, name = "box"): Promise<WatchEvent[]> {
  return (await env.ACCOUNT.get(env.ACCOUNT.idFromName(`acct:${account}`)).readEvents(name, 0, 500))?.events ?? [];
}

async function list(auth: Record<string, string>, inbox = "box"): Promise<SubscriptionInfo[]> {
  const res = await call(`/v1/inboxes/${inbox}/subscriptions`, { headers: auth });
  expect(res.status).toBe(200);
  return (await res.json<SubscriptionsResponse>()).subscriptions;
}

type Example = { action?: string; [key: string]: unknown };
const byEvent = new Map((examples as { name: string; examples: Example[] }[]).map((e) => [e.name, e.examples]));
function example(event: string, action: string): Example {
  const found = byEvent.get(event)?.find((e) => e.action === action);
  if (!found) throw new Error(`no ${event}.${action} example`);
  return structuredClone(found);
}

async function webhook(event: string, payload: unknown, delivery = crypto.randomUUID()) {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const res = await call("/github/webhook", {
    method: "POST",
    headers: { "X-GitHub-Event": event, "X-GitHub-Delivery": delivery, "X-Hub-Signature-256": await sign(body, "test-secret") },
    body,
  });
  expect(res.status).toBe(202);
  return res.json<{ installation?: { revoked: number; queued: number } | null; ingest?: unknown; revoked_keys?: number }>();
}

// ---- Tests -----------------------------------------------------------

describe("App JWT", () => {
  it("is RS256, signed with the App's key, issued by the App ID, for under 10 minutes", async () => {
    const now = Date.UTC(2026, 9, 28, 12);
    const jwt = await appJwt(env, now);
    const [h, p, s] = jwt.split(".");
    const decode = (part: string) => Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    expect(JSON.parse(new TextDecoder().decode(decode(h)))).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(new TextDecoder().decode(decode(p)));
    expect(claims.iss).toBe("5490181");
    expect(claims.iat).toBeLessThan(now / 1000);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(claims.exp).toBeGreaterThan(now / 1000);

    const pem = (env as unknown as { TEST_APP_PUBLIC_KEY: string }).TEST_APP_PUBLIC_KEY;
    const der = Uint8Array.from(atob(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("spki", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decode(s), new TextEncoder().encode(`${h}.${p}`))).toBe(true);
  });
});

describe("meta", () => {
  it("publishes the install URL and subscription limits", async () => {
    const meta = await (await call("/v1/meta")).json<Meta>();
    expect(meta.github?.install_url).toBe("https://github.com/apps/watcheroni/installations/new");
    expect(meta.limits.max_ttl_seconds).toBe(30 * 24 * 3600);
    expect(meta.limits.private_verify_seconds).toBe(7 * 24 * 3600);
  });
});

describe("subscribing to a public repo", () => {
  it("checks the installation, takes a baseline, and feeds the inbox from webhooks", async () => {
    const user = await signedIn();
    const repo = newRepo();
    const seen = mockGitHub({ repos: [repo] });

    const res = await subscribe(user.auth, { repo: fullName(repo), pr: 7, kinds: ["review.*"] });
    expect(res.status, await res.clone().text()).toBe(201);
    const sub = await res.json<SubscriptionInfo>();
    expect(sub).toEqual({
      id: expect.stringMatching(/^sub_[0-9A-Z]{26}$/),
      inbox: "box",
      repo: { id: repo.id, full_name: fullName(repo), private: false },
      pr: 7,
      kinds: ["review.*"],
      ignore: { self: false, bots: false, actors: [] },
      created_at: expect.any(String),
      expires_at: expect.any(String),
      verified_until: null,
      state: "active",
      baseline: { state: "open", head_sha: SHA, mergeable: "mergeable" },
    });
    expect(Date.parse(sub.expires_at) - Date.parse(sub.created_at)).toBe(7 * 24 * 3600_000);

    // The installation was found with the App JWT; the repo and PR read
    // with the installation token. No user token was needed.
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      `GET /repos/${fullName(repo)}/installation`,
      `POST /app/installations/${repo.installation}/access_tokens`,
      `GET /repos/${fullName(repo)}`,
      `GET /repos/${fullName(repo)}/pulls/7`,
    ]);
    expect(seen[0].auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(seen[2].auth).toBe(`Bearer ghs_${repo.installation}`);

    // RepoHub has the routing copy, with the baseline.
    const stats = await hubStats(repo.id);
    expect(stats.subscriptions.map((s) => [s.id, s.account, s.inbox, s.pr])).toEqual([[sub.id, user.id, "box", 7]]);
    expect(stats.prs).toEqual([{ number: 7, state: "open", draft: 0, head_sha: SHA, base_ref: "main", author: null }]);
    expect((await installation(repo.installation!).stats()).repos).toEqual([repo.id]);

    // A review on the PR reaches the inbox.
    const review = example("pull_request_review", "submitted") as {
      repository: { id: number; full_name: string };
      pull_request: { number: number };
    };
    review.repository.id = repo.id;
    review.repository.full_name = fullName(repo);
    review.pull_request.number = 7;
    await webhook("pull_request_review", review);
    const events = await inboxEvents(user.id);
    expect(events.map((e) => [e.kind, e.sub])).toEqual([["review.submitted", sub.id]]);
  });

  it("is idempotent, and reuses the cached installation token", async () => {
    const user = await signedIn();
    const repo = newRepo();
    const seen = mockGitHub({ repos: [repo] });
    const first = await (await subscribe(user.auth, { repo: fullName(repo), pr: 7 })).json<SubscriptionInfo>();
    const again = await subscribe(user.auth, { repo: fullName(repo), pr: 7 });
    expect(again.status).toBe(200);
    expect((await again.json<SubscriptionInfo>()).id).toBe(first.id);
    expect(seen.filter((s) => s.path.endsWith("/access_tokens"))).toHaveLength(1);
    expect((await list(user.auth)).map((s) => s.id)).toEqual([first.id]);
  });

  it("lists, gets and deletes, telling RepoHub", async () => {
    const user = await signedIn();
    const repo = newRepo({ prs: { 7: { state: "open" }, 8: { state: "open" } } });
    mockGitHub({ repos: [repo] });
    const a = await (await subscribe(user.auth, { repo: fullName(repo), pr: 7 })).json<SubscriptionInfo>();
    const b = await (await subscribe(user.auth, { repo: fullName(repo), pr: 8 })).json<SubscriptionInfo>();
    expect((await list(user.auth)).map((s) => [s.id, s.pr, s.baseline])).toEqual([[a.id, 7, undefined], [b.id, 8, undefined]]);

    const got = await call(`/v1/inboxes/box/subscriptions/${a.id}`, { headers: user.auth });
    expect((await got.json<SubscriptionInfo>()).repo.full_name).toBe(fullName(repo));

    const del = await call(`/v1/inboxes/box/subscriptions/${a.id}`, { method: "DELETE", headers: user.auth });
    expect(del.status).toBe(204);
    expect((await call(`/v1/inboxes/box/subscriptions/${a.id}`, { method: "DELETE", headers: user.auth })).status).toBe(404);
    expect((await list(user.auth)).map((s) => s.id)).toEqual([b.id]);
    expect((await hubStats(repo.id)).subscriptions.map((s) => s.id)).toEqual([b.id]);

    // Another account can't see or delete them.
    const other = await signedIn();
    expect((await call(`/v1/inboxes/box/subscriptions/${b.id}`, { headers: other.auth })).status).toBe(404);
    expect((await call(`/v1/inboxes/box/subscriptions/${b.id}`, { method: "DELETE", headers: other.auth })).status).toBe(404);
  });

  it("forgets a subscription once its PR is merged", async () => {
    const user = await signedIn();
    const repo = newRepo();
    mockGitHub({ repos: [repo] });
    const sub = await (await subscribe(user.auth, { repo: fullName(repo), pr: 7 })).json<SubscriptionInfo>();
    const closed = example("pull_request", "closed") as {
      repository: { id: number; full_name: string };
      number: number;
      pull_request: { number: number; merged: boolean };
    };
    closed.repository.id = repo.id;
    closed.number = closed.pull_request.number = 7;
    closed.pull_request.merged = true;
    await webhook("pull_request", closed);
    expect((await inboxEvents(user.id)).map((e) => [e.kind, e.sub])).toEqual([["pr.merged", sub.id], ["watch.ended", sub.id]]);
    expect(await list(user.auth)).toEqual([]);
  });

  it("answers 409 app_not_installed with the install URL", async () => {
    const user = await signedIn();
    const repo = newRepo({ installation: null });
    const seen = mockGitHub({ repos: [repo] });
    const res = await subscribe(user.auth, { repo: fullName(repo), pr: 7 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "app_not_installed", install_url: "https://github.com/apps/watcheroni/installations/new" });
    // A repo that doesn't exist looks the same.
    expect((await subscribe(user.auth, { repo: "nobody/nothing", pr: 1 })).status).toBe(409);
    expect(seen.every((s) => s.path.endsWith("/installation"))).toBe(true);
  });

  it("refuses closed and missing PRs", async () => {
    const user = await signedIn();
    const repo = newRepo({ prs: { 7: { state: "closed", merged: true }, 8: { state: "closed" } } });
    mockGitHub({ repos: [repo] });
    const merged = await subscribe(user.auth, { repo: fullName(repo), pr: 7 });
    expect(merged.status).toBe(409);
    expect(await merged.json()).toMatchObject({ code: "pr_not_open", title: "PR #7 is merged" });
    expect(await (await subscribe(user.auth, { repo: fullName(repo), pr: 8 })).json()).toMatchObject({ code: "pr_not_open" });
    const missing = await subscribe(user.auth, { repo: fullName(repo), pr: 9 });
    expect(missing.status).toBe(404);
    expect(await list(user.auth)).toEqual([]);
  });

  it("needs the inbox to exist", async () => {
    const user = await signedIn();
    const repo = newRepo();
    mockGitHub({ repos: [repo] });
    const res = await subscribe(user.auth, { repo: fullName(repo), pr: 7 }, {}, "nope");
    expect(res.status).toBe(404);
    expect((await call("/v1/inboxes/nope/subscriptions", { headers: user.auth })).status).toBe(404);
    expect((await hubStats(repo.id)).subscriptions).toEqual([]);
  });

  it("rejects malformed requests without asking GitHub", async () => {
    const user = await signedIn();
    const seen = mockGitHub({ repos: [] });
    for (const body of [
      {},
      { repo: "no-slash", pr: 1 },
      { repo: "o/r", pr: -1 },
      { repo: "o/r" },
      { repo: "o/r", pr: 1, kinds: "review.*" },
      { repo: "o/r", pr: 1, kinds: ["Not A Kind"] },
      { repo: "o/r", pr: 1, ignore: { self: "yes" } },
      { repo: "o/r", pr: 1, ttl_seconds: 1 },
      { repo: "o/r", pr: 1, base: "main" },
      { repo: "o/r", kinds: ["pr.*"], base: "" },
      { repo: "o/r", kinds: ["pr.*"], base: "has space" },
      { repo: "o/r", kinds: ["pr.*"], author: "not/a/login" },
      { repo: "o/r", kinds: ["pr.*"], author: 5 },
    ]) {
      const res = await subscribe(user.auth, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(seen).toEqual([]);
    expect((await call("/v1/inboxes/box/subscriptions", { method: "POST", body: "{}" })).status).toBe(401);
  });

  it("takes repository-wide subscriptions with kinds", async () => {
    const user = await signedIn();
    const repo = newRepo();
    const seen = mockGitHub({ repos: [repo] });
    const res = await subscribe(user.auth, { repo: fullName(repo), kinds: ["pr.opened"] });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ pr: null, kinds: ["pr.opened"] });
    expect(seen.some((s) => s.path.includes("/pulls/"))).toBe(false);
  });

  it("takes base and author filters, learning the open PRs, and delivers what matches", async () => {
    const user = await signedIn();
    const repo = newRepo({ prs: { 7: { base: "main", author: "Paul" }, 8: { base: "dev", author: "paul" }, 9: { state: "closed" } } });
    const seen = mockGitHub({ repos: [repo] });
    const res = await subscribe(user.auth, { repo: fullName(repo), kinds: ["pr.opened", "check.failed"], base: "main", author: "Paul" });
    expect(res.status, await res.clone().text()).toBe(201);
    const sub = await res.json<SubscriptionInfo>();
    expect(sub).toMatchObject({ pr: null, kinds: ["check.failed", "pr.opened"], base: "main", author: "paul" });
    expect(sub).not.toHaveProperty("baseline");
    expect(seen.map((s) => `${s.method} ${s.path}`).slice(2)).toEqual([`GET /repos/${fullName(repo)}`, `GET /repos/${fullName(repo)}/pulls`]);
    expect((await hubStats(repo.id)).prs.map((p) => [p.number, p.base_ref, p.author])).toEqual([[7, "main", "Paul"], [8, "dev", "paul"]]);
    expect((await list(user.auth)).map((s) => [s.id, s.base, s.author])).toEqual([[sub.id, "main", "paul"]]);
    // The same again is the same subscription.
    expect((await subscribe(user.auth, { repo: fullName(repo), kinds: ["pr.opened", "check.failed"], base: "main", author: "paul" })).status).toBe(200);

    // A check failing on an open PR against main by paul, and new PRs.
    const run = example("check_run", "completed") as { repository: { id: number; full_name: string }; check_run: Record<string, unknown> };
    run.repository.id = repo.id;
    Object.assign(run.check_run, { conclusion: "failure", pull_requests: [{ number: 7 }, { number: 8 }] });
    await webhook("check_run", run);
    for (const [n, base] of [[20, "main"], [21, "dev"]] as const) {
      const opened = example("pull_request", "opened") as {
        repository: { id: number }; number: number; pull_request: { number: number; base: { ref: string }; user: { login: string } };
      };
      opened.repository.id = repo.id;
      opened.number = opened.pull_request.number = n;
      opened.pull_request.base.ref = base;
      opened.pull_request.user.login = "PAUL";
      await webhook("pull_request", opened);
    }
    expect((await inboxEvents(user.id)).map((e) => [e.kind, e.pr, e.sub])).toEqual([
      ["check.failed", 7, sub.id],
      ["pr.opened", 20, sub.id],
    ]);
  });

  it("enforces the account's subscription quota", async () => {
    const user = await signedIn();
    const repo = newRepo();
    mockGitHub({ repos: [repo] });
    await runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(`acct:${user.id}`)), (_, state) => {
      for (let i = 0; i < 200; i++) {
        state.storage.sql.exec(
          "INSERT INTO subscriptions (id, inbox, repo_id, repo_name, private, pr, spec, created_at, expires_at) VALUES (?, 'box', 1, 'o/r', 0, ?, '{}', 0, 0)",
          `sub_fake${i}`, i + 1,
        );
      }
    });
    const res = await subscribe(user.auth, { repo: fullName(repo), pr: 7 });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "quota_exceeded" });
    expect((await hubStats(repo.id)).subscriptions).toEqual([]);
  });
});

describe("subscribing to a private repo", () => {
  it("needs the user's own token, able to read the repo, and forgets it", async () => {
    const user = await signedIn();
    const someoneElse = fresh();
    const outsider = fresh();
    const repo = newRepo({ private: true, readers: [user.id] });
    const seen = mockGitHub({
      repos: [repo],
      users: {
        ghu_mine: { id: user.id, login: "me" },
        ghu_theirs: { id: someoneElse, login: "them" },
        ghu_outsider: { id: outsider, login: "outsider" },
      },
    });
    const body = { repo: fullName(repo), pr: 7 };

    const none = await subscribe(user.auth, body);
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ code: "github_token_required" });

    const unknown = await subscribe(user.auth, body, { "X-GitHub-Token": "ghp_personal" });
    expect(await unknown.json()).toMatchObject({ status: 401, code: "github_token_invalid" });

    const theirs = await subscribe(user.auth, body, { "X-GitHub-Token": "ghu_theirs" });
    expect(await theirs.json()).toMatchObject({ status: 401, code: "github_token_invalid" });

    // The outsider's own key and token: GitHub won't show them the repo.
    const out = await signedIn(outsider);
    const denied = await subscribe(out.auth, body, { "X-GitHub-Token": "ghu_outsider" });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "repo_access_denied" });

    seen.length = 0;
    const ok = await subscribe(user.auth, body, { "X-GitHub-Token": "ghu_mine" });
    expect(ok.status, await ok.clone().text()).toBe(201);
    const sub = await ok.json<SubscriptionInfo>();
    expect(sub.repo.private).toBe(true);
    expect(Date.parse(sub.verified_until!) - Date.now()).toBeGreaterThan(7 * 24 * 3600_000 - 60_000);
    expect(seen.filter((s) => s.auth === "Bearer ghu_mine").map((s) => s.path)).toEqual([`/repos/${fullName(repo)}`]);
    expect((await list(user.auth))[0].verified_until).toBe(sub.verified_until);

    // The token is in no object's storage.
    for (const stub of [
      env.ACCOUNT.get(env.ACCOUNT.idFromName(`acct:${user.id}`)),
      env.REPO_HUB.get(env.REPO_HUB.idFromName(`repo:${repo.id}`)),
      installation(repo.installation!),
    ] as DurableObjectStub[]) {
      const dump = await runInDurableObject(stub, (_, state) => {
        const rows: unknown[] = [];
        for (const { name } of state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")) {
          if (!name.startsWith("_cf_") && !name.startsWith("sqlite_")) rows.push(...state.storage.sql.exec(`SELECT * FROM "${name}"`).toArray());
        }
        return JSON.stringify(rows, (_, v) => (v instanceof ArrayBuffer ? new TextDecoder().decode(v) : v));
      });
      expect(dump).not.toContain("ghu_mine");
      expect(dump).not.toContain(`ghs_${repo.installation}`);
    }
  });
});

describe("keeping subscriptions alive", () => {
  const hub = (repo: FakeRepo) => env.REPO_HUB.get(env.REPO_HUB.idFromName(`repo:${repo.id}`));
  // Makes every subscription on the repo due, as if made long ago.
  const age = (repo: FakeRepo, column: "expires_at" | "verified_until") =>
    runInDurableObject(hub(repo), (_, state) => {
      state.storage.sql.exec(`UPDATE subscriptions SET ${column} = 0, created_at = 0`);
    });
  const verify = (auth: Record<string, string>, id: string, headers: Record<string, string> = {}) =>
    call(`/v1/inboxes/box/subscriptions/${id}/verify`, { method: "POST", headers: { ...auth, ...headers } });

  it("ends an inbox's subscriptions with watch.expired once nobody has read it for the TTL", async () => {
    const user = await signedIn();
    const repo = newRepo();
    mockGitHub({ repos: [repo] });
    const sub = await (await subscribe(user.auth, { repo: fullName(repo), pr: 7 })).json<SubscriptionInfo>();
    await age(repo, "expires_at");
    expect(await runDurableObjectAlarm(hub(repo))).toBe(true);
    expect((await hubStats(repo.id)).subscriptions).toEqual([]);
    expect(await list(user.auth)).toEqual([]);
    const events = await inboxEvents(user.id);
    expect(events.map((e) => [e.kind, e.sub, e.data.reason])).toEqual([["watch.expired", sub.id, "unread"]]);
  });

  it("keeps a subscription whose inbox was read, counting the TTL from the read", async () => {
    const user = await signedIn();
    const repo = newRepo();
    mockGitHub({ repos: [repo] });
    const sub = await (await subscribe(user.auth, { repo: fullName(repo), pr: 7, ttl_seconds: 3600 })).json<SubscriptionInfo>();
    expect((await call("/v1/inboxes/box/events", { headers: user.auth })).status).toBe(200);
    await age(repo, "expires_at");
    expect(await runDurableObjectAlarm(hub(repo))).toBe(true);
    const [kept] = (await hubStats(repo.id)).subscriptions;
    expect(kept.id).toBe(sub.id);
    expect(kept.expires_at - Date.now()).toBeGreaterThan(3600_000 - 60_000);
    expect(Date.parse((await list(user.auth))[0].expires_at)).toBe(kept.expires_at);
    expect((await inboxEvents(user.id)).map((e) => e.kind)).toEqual([]);
  });

  it("renews a private repo's verification, and ends it when access is lost or it lapses", async () => {
    const user = await signedIn();
    const repo = newRepo({ private: true, readers: [user.id] });
    mockGitHub({ repos: [repo], users: { ghu_mine: { id: user.id, login: "me" } } });
    const token = { "X-GitHub-Token": "ghu_mine" };
    const first = await (await subscribe(user.auth, { repo: fullName(repo), pr: 7 }, token)).json<SubscriptionInfo>();

    expect(await (await verify(user.auth, first.id)).json()).toMatchObject({ status: 401, code: "github_token_required" });
    await runInDurableObject(hub(repo), (_, state) => {
      state.storage.sql.exec("UPDATE subscriptions SET verified_until = ?", Date.now() + 1000);
    });
    const renewed = await verify(user.auth, first.id, token);
    expect(renewed.status, await renewed.clone().text()).toBe(200);
    const until = Date.parse((await renewed.json<SubscriptionInfo>()).verified_until!);
    expect(until - Date.now()).toBeGreaterThan(7 * 24 * 3600_000 - 60_000);
    expect((await hubStats(repo.id)).subscriptions[0].verified_until).toBe(until);
    expect((await list(user.auth))[0].verified_until).toBe(new Date(until).toISOString());

    // Removed from the repo: the next verification ends it at once.
    repo.readers = [];
    const denied = await verify(user.auth, first.id, token);
    expect(denied.status).toBe(403);
    expect(await list(user.auth)).toEqual([]);
    expect((await hubStats(repo.id)).subscriptions).toEqual([]);

    // Nobody verifies in time: the alarm ends it.
    repo.readers = [user.id];
    const second = await (await subscribe(user.auth, { repo: fullName(repo), pr: 7 }, token)).json<SubscriptionInfo>();
    await age(repo, "verified_until");
    expect(await runDurableObjectAlarm(hub(repo))).toBe(true);
    expect(await list(user.auth)).toEqual([]);
    const events = await inboxEvents(user.id);
    expect(events.map((e) => [e.kind, e.sub, e.data.reason])).toEqual([
      ["watch.unverified", first.id, "access_denied"],
      ["watch.unverified", second.id, "not_verified"],
    ]);
  });

  it("verifying a public repo's subscription changes nothing", async () => {
    const user = await signedIn();
    const repo = newRepo();
    mockGitHub({ repos: [repo] });
    const sub = await (await subscribe(user.auth, { repo: fullName(repo), pr: 7 })).json<SubscriptionInfo>();
    const res = await verify(user.auth, sub.id);
    expect(res.status).toBe(200);
    expect((await res.json<SubscriptionInfo>()).verified_until).toBeNull();
    expect((await verify(user.auth, "sub_nope")).status).toBe(404);
  });
});

describe("revoking the App's authorization", () => {
  it("revokes every key the user has", async () => {
    const user = await signedIn();
    const res = await webhook("github_app_authorization", { action: "revoked", sender: { id: user.id, login: "me" } });
    expect(res).toMatchObject({ revoked_keys: 1 });
    expect((await call("/v1/keys", { headers: user.auth })).status).toBe(401);
  });
});

describe("Installation", () => {
  it("keeps the token encrypted, and mints a new one near expiry", async () => {
    const repo = newRepo();
    const seen = mockGitHub({ repos: [repo] });
    const stub = installation(repo.installation!);
    expect(await stub.token(repo.installation!)).toEqual({ ok: true, token: `ghs_${repo.installation}` });

    // Forget the in-memory copy: the stored one decrypts.
    await runInDurableObject(stub, (instance: Installation) => {
      (instance as unknown as { memo: unknown }).memo = null;
    });
    expect(await stub.token(repo.installation!)).toEqual({ ok: true, token: `ghs_${repo.installation}` });
    expect(seen.filter((s) => s.path.endsWith("/access_tokens"))).toHaveLength(1);

    // Under five minutes left: a new one.
    await runInDurableObject(stub, (instance: Installation, state) => {
      (instance as unknown as { memo: unknown }).memo = null;
      state.storage.sql.exec("UPDATE token SET expires_at = ?", Date.now() + 60_000);
    });
    expect((await stub.token(repo.installation!)).ok).toBe(true);
    expect(seen.filter((s) => s.path.endsWith("/access_tokens"))).toHaveLength(2);
  });

  it("answers rate_limited once the installation's API budget is spent", async () => {
    const user = await signedIn();
    const repo = newRepo();
    mockGitHub({ repos: [repo] });
    await runInDurableObject(installation(repo.installation!), (_, state) => {
      state.storage.sql.exec("INSERT INTO buckets (name, tokens, updated_at) VALUES ('api', 0, ?)", Date.now());
    });
    const res = await subscribe(user.auth, { repo: fullName(repo), pr: 7 });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("treats a suspended installation as not installed", async () => {
    const user = await signedIn();
    const repo = newRepo();
    mockGitHub({ repos: [repo], suspended: [repo.installation!] });
    const res = await subscribe(user.auth, { repo: fullName(repo), pr: 7 });
    expect(res.status).toBe(409);
    expect((await installation(repo.installation!).stats()).meta.suspended_at).toBeTruthy();
  });

  it("ends every watch when the App is uninstalled", async () => {
    const user = await signedIn();
    const instId = fresh();
    const a = newRepo({ installation: instId });
    const b = newRepo({ installation: instId });
    mockGitHub({ repos: [a, b] });
    const subA = await (await subscribe(user.auth, { repo: fullName(a), pr: 7 })).json<SubscriptionInfo>();
    const subB = await (await subscribe(user.auth, { repo: fullName(b), pr: 7 })).json<SubscriptionInfo>();

    const payload = example("installation", "deleted") as { installation: { id: number } };
    payload.installation.id = instId;
    const delivery = crypto.randomUUID();
    const result = await webhook("installation", payload, delivery);
    expect(result.installation).toEqual({ revoked: 2, queued: 0 });

    const events = await inboxEvents(user.id);
    expect(events.map((e) => [e.kind, e.sub, e.data.reason]).sort()).toEqual(
      [["watch.revoked", subA.id, "uninstalled"], ["watch.revoked", subB.id, "uninstalled"]].sort(),
    );
    expect(events.find((e) => e.sub === subA.id)?.id).toBe(`${delivery}.revoked.${subA.id}`);
    expect(await list(user.auth)).toEqual([]);
    expect((await hubStats(a.id)).subscriptions).toEqual([]);
    expect((await hubStats(b.id)).prs).toEqual([]);

    // Subscribing again is refused until it's reinstalled.
    const again = await subscribe(user.auth, { repo: fullName(a), pr: 7 });
    expect(again.status).toBe(409);
    const created = example("installation", "created") as { installation: { id: number } };
    created.installation.id = instId;
    await webhook("installation", created);
    expect((await subscribe(user.auth, { repo: fullName(a), pr: 7 })).status).toBe(201);
  });

  it("ends the watches on repos removed from the installation, and only those", async () => {
    const user = await signedIn();
    const instId = fresh();
    const a = newRepo({ installation: instId });
    const b = newRepo({ installation: instId });
    mockGitHub({ repos: [a, b] });
    const subA = await (await subscribe(user.auth, { repo: fullName(a), pr: 7 })).json<SubscriptionInfo>();
    const subB = await (await subscribe(user.auth, { repo: fullName(b), pr: 7 })).json<SubscriptionInfo>();

    const payload = example("installation_repositories", "removed") as {
      installation: { id: number };
      repositories_removed: { id: number }[];
    };
    payload.installation.id = instId;
    payload.repositories_removed = [{ ...payload.repositories_removed[0], id: a.id }, { id: fresh() }];
    expect((await webhook("installation_repositories", payload)).installation).toEqual({ revoked: 1, queued: 0 });
    expect((await inboxEvents(user.id)).map((e) => [e.kind, e.sub, e.data.reason])).toEqual([["watch.revoked", subA.id, "removed"]]);
    expect((await list(user.auth)).map((s) => s.id)).toEqual([subB.id]);
    expect((await installation(instId).stats()).repos).toEqual([b.id]);
  });

  it("retries a RepoHub that fails, from the alarm", async () => {
    const instId = fresh();
    const stub = installation(instId);
    let fail = true;
    await runInDurableObject(stub, (instance: Installation) => {
      instance.addRepo(12345);
      (instance as unknown as { revokeRepo: () => Promise<void> }).revokeRepo = async () => {
        if (fail) throw new Error("hub down");
      };
    });
    expect(await stub.onEvent({ id: instId, action: "suspend", account: null, repository_selection: null, repos_removed: [] }, "d1"))
      .toEqual({ revoked: 0, queued: 1 });
    expect((await stub.stats()).revocations).toEqual([{ repo_id: 12345, reason: "suspended", attempts: 1 }]);
    fail = false;
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec("UPDATE revocations SET next_at = 0");
    });
    await runInDurableObject(stub, (instance: Installation) => instance.alarm());
    expect((await stub.stats()).revocations).toEqual([]);
  });
});

describe("debug subscriptions", () => {
  it("still go straight into RepoHub without GitHub", async () => {
    const seen = mockGitHub({ repos: [] });
    const repo = fresh();
    const res = await call(`/debug/repos/${repo}/subscriptions`, {
      method: "POST",
      headers: DEBUG,
      body: JSON.stringify({ account: fresh(), inbox: "box", pr: 3, full_name: "octo/debug" }),
    });
    expect(res.status).toBe(201);
    expect(seen).toEqual([]);
  });
});
