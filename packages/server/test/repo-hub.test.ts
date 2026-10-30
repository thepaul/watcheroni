import examples from "@octokit/webhooks-examples/api.github.com/index.json";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Delivery } from "../src/account";
import type { UnsequencedEvent, WatchEvent } from "../src/protocol";
import { REPO_LIMITS, RepoHub, type IngestResult, type RepoHubStats, type Subscription } from "../src/repo-hub";
import { sign } from "../src/webhook/signature";

type Example = { action?: string; [key: string]: unknown };
const byEvent = new Map((examples as { name: string; examples: Example[] }[]).map((e) => [e.name, e.examples]));
const example = (event: string, action?: string): Example => {
  const found = byEvent.get(event)?.find((e) => e.action === action);
  if (!found) throw new Error(`no ${event}.${action} example`);
  return structuredClone(found);
};

const BASE = "https://watcheroni.test";
const AUTH = { Authorization: "Bearer test-debug-token" };
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

// Fresh repo and account IDs for every test, so tests never share state
// with each other or with webhook.test.ts.
let counter = 0;
const fresh = () => 700_000_000 + Math.floor(Math.random() * 1_000_000) * 100 + counter++;

// No test reaches the real GitHub, and RepoHub itself never asks it
// anything: any fetch fails the test that made it.
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    throw new Error(`no network in tests: ${new Request(input, init).url}`);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const hub = (repo: number) => env.REPO_HUB.get(env.REPO_HUB.idFromName(`repo:${repo}`));
const stats = (repo: number): Promise<RepoHubStats> => hub(repo).stats();

// Rewrites the example to belong to `repo` and posts it, signed.
async function webhook(event: string, payload: Example, repo: number, delivery = crypto.randomUUID()) {
  (payload.repository as { id: number }).id = repo;
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const res = await exports.default.fetch(`${BASE}/github/webhook`, {
    method: "POST",
    headers: {
      "X-GitHub-Event": event,
      "X-GitHub-Delivery": delivery,
      "X-Hub-Signature-256": await sign(body, "test-secret"),
    },
    body,
  });
  expect(res.status).toBe(202);
  return (await res.json()) as { events: UnsequencedEvent[]; ingest: IngestResult | null };
}

async function subscribe(repo: number, body: Record<string, unknown>, status = 201): Promise<Subscription> {
  const res = await exports.default.fetch(`${BASE}/debug/repos/${repo}/subscriptions`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ full_name: "octo/widgets", ...body }),
  });
  expect(res.status, await res.clone().text()).toBe(status);
  return res.json();
}

async function inbox(account: number, name: string): Promise<WatchEvent[]> {
  const page = await env.ACCOUNT.get(env.ACCOUNT.idFromName(`acct:${account}`)).readEvents(name, 0, 500);
  return page?.events ?? [];
}

const kinds = (events: WatchEvent[]) => events.map((e) => e.kind);

async function eventually(check: () => Promise<void>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return await check();
    } catch (err) {
      if (Date.now() > end) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

// A minimal normalised event, for driving `ingest` directly.
function fact(repo: number, kind: string, pr: number | null, data: UnsequencedEvent["data"] = {}): UnsequencedEvent {
  const at = new Date().toISOString();
  return {
    v: 1, id: `${crypto.randomUUID()}.0`, sub: null, kind, at, received_at: at,
    repo: { id: repo, full_name: "octo/widgets" }, pr,
    actor: { id: 1, login: "alice", bot: false }, data, links: {},
  };
}

describe("ingest from GitHub's examples", () => {
  it("delivers a review to the PR's subscriber", async () => {
    const repo = fresh();
    const acct = fresh();
    const payload = example("pull_request_review", "submitted");
    const pr = (payload.pull_request as { number: number }).number;
    const sub = await subscribe(repo, { account: acct, inbox: "i", pr });

    const { ingest } = await webhook("pull_request_review", payload, repo);
    expect(ingest).toEqual({ accepted: true, events: 1, delivered: 1, queued: 0 });
    const got = await inbox(acct, "i");
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ seq: 1, kind: "review.submitted", sub: sub.id, pr, repo: { id: repo } });
  });

  it("does nothing for an unwatched repo", async () => {
    const repo = fresh();
    const { ingest } = await webhook("pull_request", example("pull_request", "opened"), repo);
    expect(ingest).toMatchObject({ accepted: false, reason: "no_subscriptions" });
    expect((await stats(repo)).meta.full_name).toBeUndefined();
  });

  it("takes every example, and never delivers internal kinds", async () => {
    const acct = fresh();
    const seen = new Set<string>();
    for (const [event, list] of byEvent) {
      // One repo per event type keeps each well inside the ingest burst.
      const repo = fresh();
      await subscribe(repo, { account: acct, inbox: "all", pr: null, kinds: ["*"] });
      for (const payload of list) {
        if (!payload.repository) continue;
        const { events, ingest } = await webhook(event, structuredClone(payload), repo);
        if (events.length) expect(ingest?.accepted).toBe(true);
        else expect(ingest).toBeNull();
      }
    }
    for (const e of await inbox(acct, "all")) seen.add(e.kind);
    for (const gone of ["pr.seen", "check.started", "check_suite.updated", "base.advanced", "checks.completed", "merge.conflict", "merge.clean"]) {
      expect(seen).not.toContain(gone);
    }
    for (const k of ["pr.opened", "pr.closed", "review.submitted", "review_comment.created", "comment.created", "check.completed", "workflow.completed", "issue.opened"]) {
      expect(seen).toContain(k);
    }
    // Hundreds of webhooks: well over the default 5 s on a slow CI runner.
  }, 30_000);
});

describe("matching", () => {
  it("matches checks and statuses with no PR by the PR's head SHA", async () => {
    const repo = fresh();
    const acct = fresh();
    const other = fresh();
    const sub = await subscribe(repo, { account: acct, inbox: "i", pr: 7, kinds: ["check.failed"], baseline: { state: "open", head_sha: SHA_A } });
    await subscribe(repo, { account: other, inbox: "i", pr: 8, baseline: { state: "open", head_sha: SHA_B } });

    const status = example("status");
    Object.assign(status, { sha: SHA_A, state: "failure", context: "ci/lint" });
    expect((await webhook("status", status, repo)).ingest).toMatchObject({ accepted: true, events: 1 });

    const run = example("check_run", "completed");
    Object.assign(run.check_run as object, { head_sha: SHA_A, conclusion: "timed_out", pull_requests: [] });
    const delivery = crypto.randomUUID();
    await webhook("check_run", run, repo, delivery);

    const got = await inbox(acct, "i");
    expect(got.map((e) => [e.kind, e.pr, e.sub, e.data.name ?? null])).toEqual([
      ["check.failed", 7, sub.id, "ci/lint"],
      ["check.failed", 7, sub.id, (run.check_run as { name: string }).name],
    ]);
    // A copy given a PR gets an ID of its own.
    expect(got[1].id).toBe(`${delivery}.1.pr7`);
    expect(await inbox(other, "i")).toEqual([]);
  });

  it("follows the head when the PR is pushed to", async () => {
    const repo = fresh();
    const acct = fresh();
    await subscribe(repo, { account: acct, inbox: "i", pr: 7, kinds: ["check.*"], baseline: { state: "open", head_sha: SHA_A } });

    const push = example("pull_request", "synchronize");
    (push.pull_request as { number: number }).number = 7;
    Object.assign(push, { before: SHA_A, after: SHA_B });
    await webhook("pull_request", push, repo);
    expect((await stats(repo)).prs).toMatchObject([{ number: 7, head_sha: SHA_B }]);

    const old = Object.assign(example("status"), { sha: SHA_A, state: "error", context: "old" });
    expect((await webhook("status", old, repo)).ingest).toMatchObject({ accepted: true, events: 0 });
    const now = Object.assign(example("status"), { sha: SHA_B, state: "error", context: "new" });
    expect((await webhook("status", now, repo)).ingest).toMatchObject({ accepted: true, events: 2 });
    // `pr.pushed` was filtered out by kinds; only the new head's status arrives.
    expect((await inbox(acct, "i")).map((e) => [e.kind, e.data.name])).toEqual([["check.completed", "new"], ["check.failed", "new"]]);
  });

  it("applies kinds, repo-wide subscriptions and ignore rules", async () => {
    const repo = fresh();
    const acct = fresh();
    const prSub = await subscribe(repo, { account: acct, inbox: "pr", pr: 3, kinds: ["review.*"] });
    const wide = await subscribe(repo, { account: acct, inbox: "wide", pr: null, kinds: ["issue.*", "pr.opened"] });
    await subscribe(repo, { account: acct, inbox: "quiet", pr: 3, ignore: { actors: ["alice"] } });
    await subscribe(repo, { account: acct, inbox: "nobots", pr: 3, ignore: { bots: true } });

    const bot = { id: 2, login: "dependabot[bot]", bot: true };
    const res = await hub(repo).ingest("d1", [
      fact(repo, "review.submitted", 3, { review_id: 1, state: "approved" }),
      fact(repo, "comment.created", 3, { comment_id: 1 }),
      { ...fact(repo, "comment.created", 3, { comment_id: 2 }), actor: bot },
      fact(repo, "issue.opened", null, { issue: 9 }),
      fact(repo, "pr.opened", 4, { head_sha: SHA_A, base: "main", draft: false }),
    ]);
    expect(res.accepted).toBe(true);
    expect((await inbox(acct, "pr")).map((e) => [e.kind, e.sub])).toEqual([["review.submitted", prSub.id]]);
    expect((await inbox(acct, "wide")).map((e) => [e.kind, e.sub])).toEqual([["issue.opened", wide.id], ["pr.opened", wide.id]]);
    expect(kinds(await inbox(acct, "quiet"))).toEqual(["comment.created"]);
    expect(kinds(await inbox(acct, "nobots"))).toEqual(["review.submitted", "comment.created"]);
  });

  it("delivers once per inbox, naming the first subscription", async () => {
    const repo = fresh();
    const acct = fresh();
    const first = await subscribe(repo, { account: acct, inbox: "i", pr: 3 });
    await subscribe(repo, { account: acct, inbox: "i", pr: null, kinds: ["review.*"] });
    await hub(repo).ingest("d1", [fact(repo, "review.submitted", 3, {})]);
    expect((await inbox(acct, "i")).map((e) => e.sub)).toEqual([first.id]);
  });
});

describe("repo-wide base and author filters", () => {
  // A pull_request webhook for PR `n` against `base`, opened by `author`.
  function prEvent(action: string, n: number, base: string, author: string): Example {
    const payload = example("pull_request", action);
    Object.assign(payload, { number: n });
    const pr = payload.pull_request as { number: number; base: { ref: string }; user: { login: string }; state: string };
    Object.assign(pr, { number: n, state: action === "closed" ? "closed" : "open" });
    pr.base.ref = base;
    pr.user.login = author;
    return payload;
  }

  it("match PRs by the branch they target and who opened them", async () => {
    const repo = fresh();
    const acct = fresh();
    const toMain = await subscribe(repo, { account: acct, inbox: "main", pr: null, kinds: ["pr.*", "review.*"], base: "main" });
    const byAlice = await subscribe(repo, { account: acct, inbox: "alice", pr: null, kinds: ["pr.*", "review.*", "issue.*"], author: "Alice" });
    await subscribe(repo, { account: acct, inbox: "both", pr: null, kinds: ["pr.opened"], base: "main", author: "bob" });
    await subscribe(repo, { account: acct, inbox: "all", pr: null, kinds: ["pr.opened", "review.*"] });
    // Logins are compared without case.
    expect(byAlice.author).toBe("alice");

    await webhook("pull_request", prEvent("opened", 11, "main", "alice"), repo);
    await webhook("pull_request", prEvent("opened", 12, "dev", "alice"), repo);
    await webhook("pull_request", prEvent("opened", 13, "main", "bob"), repo);
    await hub(repo).ingest("d1", [
      fact(repo, "review.submitted", 12, { review_id: 1, state: "approved" }),
      // A PR nobody here has heard of matches no filter.
      fact(repo, "review.submitted", 99, { review_id: 2, state: "approved" }),
      fact(repo, "issue.opened", null, { issue: 5 }),
    ]);

    const got = async (name: string) => (await inbox(acct, name)).map((e) => [e.kind, e.pr]);
    expect(await got("main")).toEqual([["pr.opened", 11], ["pr.opened", 13]]);
    expect((await inbox(acct, "main"))[0].sub).toBe(toMain.id);
    expect(await got("alice")).toEqual([["pr.opened", 11], ["pr.opened", 12], ["review.submitted", 12]]);
    expect(await got("both")).toEqual([["pr.opened", 13]]);
    expect(await got("all")).toEqual([["pr.opened", 11], ["pr.opened", 12], ["pr.opened", 13], ["review.submitted", 12], ["review.submitted", 99]]);
    // pr.seen stays inside RepoHub.
    expect((await inbox(acct, "all")).some((e) => e.kind === "pr.seen")).toBe(false);
    expect((await stats(repo)).prs.map((p) => [p.number, p.base_ref, p.author])).toEqual([
      [11, "main", "alice"], [12, "dev", "alice"], [13, "main", "bob"],
    ]);
  });

  it("follow a PR moved to another base", async () => {
    const repo = fresh();
    const acct = fresh();
    await subscribe(repo, { account: acct, inbox: "i", pr: null, kinds: ["pr.*", "comment.created"], base: "main" });
    await webhook("pull_request", prEvent("opened", 4, "dev", "alice"), repo);
    await hub(repo).ingest("d1", [fact(repo, "pr.base_changed", 4, { from: "dev", to: "main" })]);
    await hub(repo).ingest("d2", [fact(repo, "comment.created", 4, { comment_id: 1 })]);
    expect(kinds(await inbox(acct, "i"))).toEqual(["pr.base_changed", "comment.created"]);
  });

  it("know the PRs open when subscribing, and only while a filter needs them", async () => {
    const repo = fresh();
    const acct = fresh();
    await subscribe(repo, { account: acct, inbox: "pr", pr: 2, baseline: { state: "open", head_sha: SHA_B, base_ref: "main" } });
    const open = [
      { number: 1, head_sha: SHA_A, base_ref: "main", author: "Carol", draft: false },
      { number: 2, head_sha: SHA_B, base_ref: "main", author: "dave", draft: true },
    ];
    const wide = (body: { kinds: string[]; author?: string; base?: string }) =>
      hub(repo).subscribe({ account: acct, inbox: "wide", pr: null, ...body }, { id: repo, full_name: "octo/widgets" });
    const result = await wide({ kinds: ["check.failed", "pr.closed"], author: "carol" });
    if (!result.ok) throw new Error(result.detail);
    // The first filter asks for the open PRs; later ones, and the same
    // one again, don't.
    expect(result.needs_open_prs).toBe(true);
    expect(await wide({ kinds: ["check.failed", "pr.closed"], author: "carol" })).toMatchObject({ ok: true, created: false });
    expect(await wide({ kinds: ["check.failed", "pr.closed"], author: "carol" })).not.toHaveProperty("needs_open_prs");
    const second = await wide({ kinds: ["pr.opened"], base: "main" });
    expect(second).toMatchObject({ ok: true, created: true });
    expect(second).not.toHaveProperty("needs_open_prs");
    await hub(repo).rememberOpenPrs(open);
    expect((await stats(repo)).prs.map((p) => [p.number, p.author, p.head_sha])).toEqual([[1, "Carol", SHA_A], [2, "dave", SHA_B]]);
    if (second.ok) await hub(repo).unsubscribe(second.subscription.id);

    // A status carries only a head SHA; it's matched to the PR at that head.
    const status = Object.assign(example("status"), { sha: SHA_A, state: "failure", context: "ci" });
    await webhook("status", status, repo);
    expect((await inbox(acct, "wide")).map((e) => [e.kind, e.pr])).toEqual([["check.failed", 1]]);

    // A closed PR is forgotten once nothing watches it.
    await hub(repo).ingest("d1", [fact(repo, "pr.closed", 1)]);
    expect(kinds(await inbox(acct, "wide"))).toEqual(["check.failed", "pr.closed"]);
    expect((await stats(repo)).prs.map((p) => p.number)).toEqual([2]);

    // So is every PR no PR subscription watches, once the filter goes.
    await webhook("pull_request", prEvent("opened", 3, "main", "carol"), repo);
    expect((await stats(repo)).prs.map((p) => p.number)).toEqual([2, 3]);
    expect(await hub(repo).unsubscribe(result.subscription.id)).toBe(true);
    expect((await stats(repo)).prs.map((p) => p.number)).toEqual([2]);
    // And new PRs aren't remembered without one.
    await webhook("pull_request", prEvent("opened", 4, "main", "carol"), repo);
    expect((await stats(repo)).prs.map((p) => p.number)).toEqual([2]);
  });

  it("take only the gaps from an open-PR listing for PRs already known", async () => {
    const repo = fresh();
    const result = await hub(repo).subscribe(
      { account: fresh(), inbox: "i", pr: null, kinds: ["pr.*"], base: "main" },
      { id: repo, full_name: "octo/widgets" },
    );
    expect(result).toMatchObject({ ok: true, needs_open_prs: true });
    // Between the listing and rememberOpenPrs: PR 4 merged, PR 5 was pushed
    // to and moved to dev, with its author not yet known.
    await runInDurableObject(hub(repo), (_: RepoHub, state) => {
      state.storage.sql.exec("INSERT INTO prs (number, state, head_sha, base_ref, author) VALUES (4, 'merged', ?, 'main', 'x')", SHA_A);
      state.storage.sql.exec("INSERT INTO prs (number, state, draft, head_sha, base_ref) VALUES (5, 'open', 0, ?, 'dev')", SHA_A);
    });
    await hub(repo).rememberOpenPrs([4, 5, 6].map((n) => ({ number: n, head_sha: SHA_B, base_ref: "main", author: `u${n}`, draft: true })));
    const prs = (await stats(repo)).prs.map((p) => [p.number, p.state, p.draft, p.head_sha, p.base_ref, p.author]);
    expect(prs).toEqual([
      [4, "merged", 1, SHA_A, "main", "x"],
      [5, "open", 0, SHA_A, "dev", "u5"],
      [6, "open", 1, SHA_B, "main", "u6"],
    ]);
  });

  it("write a PR's row only to fill a gap", async () => {
    const repo = fresh();
    const acct = fresh();
    await subscribe(repo, { account: acct, inbox: "i", pr: null, kinds: ["review.*"], author: "alice" });
    const seenAt = () => runInDurableObject(hub(repo), (_: RepoHub, state) =>
      state.storage.sql.exec<{ seen_at: number | null; state: string | null; author: string | null }>(
        "SELECT seen_at, state, author FROM prs WHERE number = 9").one());
    // A row made from a reopen knows nothing but its state.
    await hub(repo).ingest("d1", [fact(repo, "pr.reopened", 9)]);
    await runInDurableObject(hub(repo), (_: RepoHub, state) => {
      state.storage.sql.exec("UPDATE prs SET seen_at = 1 WHERE number = 9");
    });
    const seen = (head: string | null) => fact(repo, "pr.seen", 9, { head_sha: head, base: "main", author: "alice", state: "open" });
    await hub(repo).ingest("d2", [seen(SHA_A)]);
    const filled = await seenAt();
    expect(filled).toMatchObject({ state: "open", author: "alice" });
    expect(filled.seen_at).toBeGreaterThan(1);
    // Nothing left to fill: no write, so seen_at stays put.
    await runInDurableObject(hub(repo), (_: RepoHub, state) => {
      state.storage.sql.exec("UPDATE prs SET seen_at = 1 WHERE number = 9");
    });
    await hub(repo).ingest("d3", [seen(SHA_B)]);
    expect((await seenAt()).seen_at).toBe(1);
    expect((await stats(repo)).prs[0].head_sha).toBe(SHA_A);
  });

  it("forget the least recently seen PRs when full, but never a watched one", async () => {
    const repo = fresh();
    const acct = fresh();
    await subscribe(repo, { account: acct, inbox: "pr", pr: 1 });
    await subscribe(repo, { account: acct, inbox: "i", pr: null, kinds: ["pr.*"], base: "main" });
    const cap = REPO_LIMITS.trackedPrs;
    try {
      await runInDurableObject(hub(repo), () => {
        REPO_LIMITS.trackedPrs = 3;
      });
      for (const n of [2, 3, 4]) {
        await hub(repo).ingest(`d${n}`, [fact(repo, "pr.opened", n, { head_sha: SHA_A, base: "main", draft: false })]);
        // Distinct, increasing seen_at.
        await runInDurableObject(hub(repo), (_: RepoHub, state) => {
          state.storage.sql.exec("UPDATE prs SET seen_at = ? WHERE number = ?", n, n);
        });
      }
      // PR 1 is watched, so 2, the oldest of the rest, made room for 4.
      expect((await stats(repo)).prs.map((p) => p.number)).toEqual([1, 3, 4]);
      // Three more fit only two: 3 and 4 go, and 1 stays.
      await hub(repo).rememberOpenPrs([5, 6, 7].map((n) => ({ number: n, head_sha: SHA_B, base_ref: "main", author: "x", draft: false })));
      expect((await stats(repo)).prs.map((p) => p.number)).toEqual([1, 5, 6]);
    } finally {
      await runInDurableObject(hub(repo), () => {
        REPO_LIMITS.trackedPrs = cap;
      });
    }
  });

  it("are part of what makes a subscription the same", async () => {
    const repo = fresh();
    const acct = fresh();
    const plain = await subscribe(repo, { account: acct, inbox: "i", pr: null, kinds: ["pr.opened"] });
    const main = await subscribe(repo, { account: acct, inbox: "i", pr: null, kinds: ["pr.opened"], base: "main" });
    const again = await subscribe(repo, { account: acct, inbox: "i", pr: null, kinds: ["pr.opened"], base: "main" }, 200);
    const paul = await subscribe(repo, { account: acct, inbox: "i", pr: null, kinds: ["pr.opened"], author: "Paul" });
    const paulAgain = await subscribe(repo, { account: acct, inbox: "i", pr: null, kinds: ["pr.opened"], author: "paul" }, 200);
    expect(new Set([plain.id, main.id, paul.id]).size).toBe(3);
    expect([again.id, paulAgain.id]).toEqual([main.id, paul.id]);
    expect(plain).not.toHaveProperty("base");
    expect(main.base).toBe("main");
    await subscribe(repo, { account: acct, inbox: "i", pr: 1, base: "main" }, 400);
    await subscribe(repo, { account: acct, inbox: "i", pr: null, kinds: ["pr.opened"], author: "" }, 400);
  });
});

describe("subscriptions", () => {
  it("are idempotent and validated", async () => {
    const repo = fresh();
    const acct = fresh();
    const a = await subscribe(repo, { account: acct, inbox: "i", pr: 1, kinds: ["b", "a"] });
    const b = await subscribe(repo, { account: acct, inbox: "i", pr: 1, kinds: ["a", "b"] }, 200);
    expect(b.id).toBe(a.id);
    await subscribe(repo, { account: acct, inbox: "i", pr: null }, 400);
    await subscribe(repo, { account: acct, inbox: "i", pr: 2, baseline: { state: "merged", head_sha: null } }, 409);
  });

  it("limits repository-wide subscriptions", async () => {
    const repo = fresh();
    for (let i = 0; i < REPO_LIMITS.repoWideSubscriptions; i++) {
      await subscribe(repo, { account: fresh(), inbox: "i", pr: null, kinds: ["issue.*"] });
    }
    await subscribe(repo, { account: fresh(), inbox: "i", pr: null, kinds: ["issue.*"] }, 422);
  });

  it("unsubscribing forgets the PR", async () => {
    const repo = fresh();
    const sub = await subscribe(repo, { account: fresh(), inbox: "i", pr: 5, baseline: { state: "open", head_sha: SHA_A } });
    const del = () => exports.default.fetch(`${BASE}/debug/repos/${repo}/subscriptions/${sub.id}`, { method: "DELETE", headers: AUTH });
    expect((await del()).status).toBe(204);
    expect((await del()).status).toBe(404);
    expect(await stats(repo)).toMatchObject({ subscriptions: [], prs: [] });
  });
});

describe("schema migration", () => {
  // Older shapes of the tables. Version 3 meant different things on two
  // branches: prs.author (ticket 007) or check tables (ticket 003). 5 had
  // the derived events' tables, columns and meta rows that 6 removed.
  const SUBS_V2 = `CREATE TABLE subscriptions (id TEXT PRIMARY KEY, account_id INTEGER NOT NULL, inbox TEXT NOT NULL, pr INTEGER,
    spec TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, verified_until INTEGER, ttl_seconds INTEGER)`;
  const PRS_V2 = `CREATE TABLE prs (number INTEGER PRIMARY KEY, state TEXT, draft INTEGER, head_sha TEXT, base_ref TEXT,
    mergeable TEXT, mergeable_checked_at INTEGER)`;
  const shapes: Record<string, { version: string; sql: string[]; author?: string }> = {
    v2: { version: "2", sql: [SUBS_V2, PRS_V2] },
    "v3 from ticket 003": {
      version: "3",
      sql: [
        SUBS_V2, PRS_V2,
        "CREATE TABLE checks (head_sha TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, name TEXT, app_id INTEGER, suite_id INTEGER, status TEXT, conclusion TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (head_sha, kind, key))",
        "CREATE TABLE rollups (head_sha TEXT PRIMARY KEY, result TEXT NOT NULL, updated_at INTEGER NOT NULL)",
        `INSERT INTO checks (head_sha, kind, key, status, updated_at) VALUES ('${SHA_A}', 'run', '1', 'queued', 0)`,
      ],
    },
    "v3 from ticket 007": { version: "3", sql: [SUBS_V2, `${PRS_V2.slice(0, -1)}, author TEXT)`], author: "alice" },
    v4: { version: "4", sql: [SUBS_V2, `${PRS_V2.slice(0, -1)}, author TEXT, seen_at INTEGER)`], author: "alice" },
    v5: {
      version: "5",
      sql: [
        SUBS_V2, `${PRS_V2.slice(0, -1)}, author TEXT, seen_at INTEGER)`,
        `CREATE TABLE checks (head_sha TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, name TEXT, app_id INTEGER, suite_id INTEGER,
          status TEXT, conclusion TEXT, ord INTEGER NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY (head_sha, kind, key))`,
        "CREATE TABLE rollups (pr INTEGER PRIMARY KEY, head_sha TEXT, fingerprint TEXT, settle_at INTEGER)",
        `INSERT INTO checks (head_sha, kind, key, status, ord, seen_at) VALUES ('${SHA_A}', 'run', '1', 'queued', 0, 0)`,
        "INSERT INTO rollups (pr, settle_at) VALUES (5, 1)",
        "INSERT INTO meta (k, v) VALUES ('merge_check_at', '1'), ('merge_requests', '3'), ('derived_seq', '2'), ('installation_id', '9')",
        "INSERT INTO buckets (name, tokens, updated_at) VALUES ('api', 10, 0)",
      ],
      author: "alice",
    },
  };

  for (const [name, shape] of Object.entries(shapes)) {
    it(`brings ${name} to the current schema, keeping its rows`, async () => {
      const repo = fresh();
      await subscribe(repo, { account: fresh(), inbox: "i", pr: 1 });
      await runInDurableObject(hub(repo), (_: RepoHub, state) => {
        const sql = state.storage.sql;
        sql.exec("DROP TABLE subscriptions");
        sql.exec("DROP TABLE prs");
        sql.exec("DROP TABLE check_runs");
        for (const stmt of shape.sql) sql.exec(stmt);
        sql.exec("INSERT INTO subscriptions (id, account_id, inbox, pr, spec, created_at, expires_at) VALUES ('sub_a', 1, 'i', 5, ?, 0, ?)",
          JSON.stringify({ kinds: [], ignore: { self: false, bots: false, actors: [] } }), Date.now() + 3600_000);
        sql.exec(`INSERT INTO subscriptions (id, account_id, inbox, pr, spec, created_at, expires_at) VALUES ('sub_b', 1, 'w', NULL, ?, 0, ?)`,
          JSON.stringify({ kinds: ["pr.opened"], ignore: { self: false, bots: false, actors: [] }, base: "main" }), Date.now() + 3600_000);
        if (shape.author) sql.exec("INSERT INTO prs (number, state, head_sha, author) VALUES (5, 'open', ?, ?)", SHA_A, shape.author);
        else sql.exec("INSERT INTO prs (number, state, head_sha) VALUES (5, 'open', ?)", SHA_A);
        sql.exec("UPDATE meta SET v = ? WHERE k = 'schema_version'", shape.version);
        sql.exec("DELETE FROM meta WHERE k = 'tracks_all_prs'");

        // A fresh object over the old storage migrates it, twice harmlessly.
        new RepoHub(state, env);
        new RepoHub(state, env);
        const meta = (k: string) => sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v;
        expect(meta("schema_version")).toBe("6");
        expect(meta("tracks_all_prs")).toBe("1");
        const cols = (t: string) => sql.exec<{ name: string }>("SELECT name FROM pragma_table_info(?)", t).toArray().map((c) => c.name);
        expect(cols("prs")).toEqual(["number", "state", "draft", "head_sha", "base_ref", "author", "seen_at"]);
        expect(sql.exec("SELECT number, head_sha, author FROM prs").toArray()).toEqual([{ number: 5, head_sha: SHA_A, author: shape.author ?? null }]);
        expect(sql.exec("SELECT id FROM subscriptions ORDER BY id").toArray()).toEqual([{ id: "sub_a" }, { id: "sub_b" }]);
        // The derived events' tables and state are gone, and the check runs
        // passed on start empty.
        expect(cols("checks")).toEqual([]);
        expect(cols("rollups")).toEqual([]);
        expect(cols("check_runs")).toEqual(["id", "conclusion", "completed_at", "seen_at"]);
        expect(sql.exec("SELECT 1 FROM check_runs").toArray()).toEqual([]);
        for (const k of ["merge_check_at", "merge_requests", "derived_seq", "installation_id"]) expect(meta(k)).toBeUndefined();
        expect(sql.exec("SELECT 1 FROM buckets WHERE name = 'api'").toArray()).toEqual([]);
      });
      // And it works: the filter matches PR 5's base once known.
      await hub(repo).ingest("d1", [fact(repo, "pr.base_changed", 5, { from: "dev", to: "main" })]);
      expect((await stats(repo)).prs[0].base_ref).toBe("main");
    });
  }
});

describe("dedupe", () => {
  it("drops a redelivered webhook by its delivery ID", async () => {
    const repo = fresh();
    const acct = fresh();
    const payload = example("pull_request_review", "submitted");
    await subscribe(repo, { account: acct, inbox: "i", pr: (payload.pull_request as { number: number }).number });
    const first = await webhook("pull_request_review", structuredClone(payload), repo, "same-guid");
    const again = await webhook("pull_request_review", structuredClone(payload), repo, "same-guid");
    expect(first.ingest?.accepted).toBe(true);
    expect(again.ingest).toMatchObject({ accepted: false, reason: "duplicate" });
    expect(await inbox(acct, "i")).toHaveLength(1);
  });
});

describe("outbox", () => {
  it("delivers 20 accounts inline and the rest from the alarm", async () => {
    const repo = fresh();
    const accounts = Array.from({ length: 25 }, fresh);
    for (const a of accounts) await subscribe(repo, { account: a, inbox: "i", pr: 1 });
    const res = await hub(repo).ingest("d1", [fact(repo, "comment.created", 1, { comment_id: 1 })]);
    expect(res).toEqual({ accepted: true, events: 25, delivered: 20, queued: 5 });

    await eventually(async () => {
      for (const a of accounts) expect(kinds(await inbox(a, "i"))).toEqual(["comment.created"]);
    });
    expect((await stats(repo)).outbox).toEqual([]);
  });

  it("retries an account that fails, without duplicating events", async () => {
    const repo = fresh();
    const acct = fresh();
    await subscribe(repo, { account: acct, inbox: "i", pr: 1 });
    type Hooks = { sendToAccount?: (a: number, items: Delivery[]) => Promise<void> };
    await runInDurableObject(hub(repo), (instance: RepoHub) => {
      (instance as unknown as Hooks).sendToAccount = async () => {
        throw new Error("account unavailable");
      };
    });
    const ev = fact(repo, "comment.created", 1, { comment_id: 1 });
    expect(await hub(repo).ingest("d1", [ev])).toEqual({ accepted: true, events: 1, delivered: 0, queued: 1 });
    const [row] = (await stats(repo)).outbox;
    expect(row).toMatchObject({ attempts: 1, account_id: acct });
    expect(row.next_at - Date.now()).toBeGreaterThan(3000);

    await runInDurableObject(hub(repo), (instance: RepoHub, state) => {
      delete (instance as unknown as Hooks).sendToAccount;
      state.storage.sql.exec("UPDATE outbox SET next_at = 0");
    });
    expect(await runDurableObjectAlarm(hub(repo))).toBe(true);
    expect((await stats(repo)).outbox).toEqual([]);
    const got = await inbox(acct, "i");
    expect(got.map((e) => e.id)).toEqual([ev.id]);
  });
});

describe("end of a watch", () => {
  it("sends watch.ended after a merge and drops the PR's subscriptions", async () => {
    const repo = fresh();
    const acct = fresh();
    const other = fresh();
    await subscribe(repo, { account: acct, inbox: "a", pr: 5, baseline: { state: "open", head_sha: SHA_A } });
    await subscribe(repo, { account: other, inbox: "b", pr: 5, kinds: ["check.*"] });
    await subscribe(repo, { account: acct, inbox: "wide", pr: null, kinds: ["pr.*"] });
    const keep = await subscribe(repo, { account: acct, inbox: "a", pr: 6 });

    const closed = example("pull_request", "closed");
    Object.assign(closed.pull_request as object, { number: 5, merged: true, merge_commit_sha: SHA_B });
    await webhook("pull_request", closed, repo);

    expect((await inbox(acct, "a")).map((e) => [e.kind, e.pr, e.data])).toEqual([
      ["pr.merged", 5, { merge_sha: SHA_B }],
      ["watch.ended", 5, { reason: "merged" }],
    ]);
    // watch.* gets through any kinds filter.
    expect(kinds(await inbox(other, "b"))).toEqual(["watch.ended"]);
    // A repo-wide subscription sees the merge but doesn't end.
    expect(kinds(await inbox(acct, "wide"))).toEqual(["pr.merged"]);

    const s = await stats(repo);
    expect(s.subscriptions.map((x) => x.pr)).toEqual([null, 6]);
    expect(s.subscriptions[1].id).toBe(keep.id);
    expect(s.prs.map((p) => p.number)).toEqual([6]);

    await hub(repo).ingest("later", [fact(repo, "comment.created", 5, {})]);
    expect(await inbox(acct, "a")).toHaveLength(2);
  });

  it("says closed for a PR closed without merging", async () => {
    const repo = fresh();
    const acct = fresh();
    await subscribe(repo, { account: acct, inbox: "a", pr: 5 });
    await hub(repo).ingest("d1", [fact(repo, "pr.closed", 5)]);
    expect((await inbox(acct, "a")).map((e) => [e.kind, e.data.reason ?? null])).toEqual([
      ["pr.closed", null],
      ["watch.ended", "closed"],
    ]);
  });
});

describe("throttling", () => {
  it("still ends the watches of a PR merged while throttled", async () => {
    const repo = fresh();
    const acct = fresh();
    await subscribe(repo, { account: acct, inbox: "a", pr: 5 });
    await subscribe(repo, { account: acct, inbox: "reviews", pr: 5, kinds: ["review.*"] });
    await subscribe(repo, { account: acct, inbox: "wide", pr: null, kinds: ["pr.*"] });
    const keep = await subscribe(repo, { account: acct, inbox: "b", pr: 6 });
    await runInDurableObject(hub(repo), (_: RepoHub, state) => {
      state.storage.sql.exec("INSERT INTO buckets (name, tokens, updated_at) VALUES ('ingest', 0, ?)", Date.now());
    });
    const res = await hub(repo).ingest("m", [
      fact(repo, "comment.created", 5, { comment_id: 1 }),
      fact(repo, "pr.merged", 5, { merge_sha: SHA_B }),
    ]);
    expect(res).toMatchObject({ accepted: false, reason: "throttled" });
    // The PR's subscriptions get the merge (if their kinds take it) and
    // watch.ended, but not the comment.
    expect(kinds(await inbox(acct, "a"))).toEqual(["repo.throttled", "pr.merged", "watch.ended"]);
    expect(kinds(await inbox(acct, "reviews"))).toEqual(["repo.throttled", "watch.ended"]);
    // Nothing for other PRs or repository-wide subscriptions.
    expect(kinds(await inbox(acct, "wide"))).toEqual(["repo.throttled"]);
    expect(kinds(await inbox(acct, "b"))).toEqual(["repo.throttled"]);
    const s = await stats(repo);
    expect(s.subscriptions.map((x) => x.id).sort()).toEqual([keep.id, s.subscriptions.find((x) => x.pr === null)!.id].sort());
    expect(s.prs.map((p) => p.number)).toEqual([6]);
  });


  it("drops deliveries past the burst, tells each inbox once, and reports the count when it lifts", async () => {
    const repo = fresh();
    const acct = fresh();
    const sub = await subscribe(repo, { account: acct, inbox: "i", pr: 1 });
    await subscribe(repo, { account: acct, inbox: "i", pr: 2 });
    await subscribe(repo, { account: fresh(), inbox: "other", pr: 2 });

    // Events for an unwatched PR: they use the bucket but deliver nothing.
    for (let i = 0; i < REPO_LIMITS.ingest.capacity; i++) {
      expect((await hub(repo).ingest(`d${i}`, [fact(repo, "comment.created", 99)])).accepted).toBe(true);
    }
    const over = await hub(repo).ingest("over-1", [fact(repo, "comment.created", 1)]);
    expect(over).toMatchObject({ accepted: false, reason: "throttled", events: 2 });
    await hub(repo).ingest("over-2", [fact(repo, "comment.created", 1)]);

    const throttled = await inbox(acct, "i");
    expect(throttled.map((e) => [e.kind, e.sub])).toEqual([["repo.throttled", sub.id]]);
    const until = Date.parse(throttled[0].data.until as string);
    // Back at 50 tokens, refilling at one every 6 s: about 5 minutes.
    expect(until - Date.now()).toBeGreaterThan(4 * 60_000);
    expect((await stats(repo)).meta).toMatchObject({ dropped: "2", throttled_until: String(until) });

    // Move time on: the throttle has run out and the bucket refilled.
    await runInDurableObject(hub(repo), (_: RepoHub, state) => {
      state.storage.sql.exec("UPDATE meta SET v = ? WHERE k = 'throttled_until'", String(Date.now() - 1));
      state.storage.sql.exec("UPDATE buckets SET tokens = ? WHERE name = 'ingest'", REPO_LIMITS.ingestResume);
    });
    expect(await runDurableObjectAlarm(hub(repo))).toBe(true);
    expect((await inbox(acct, "i")).map((e) => [e.kind, e.data])).toEqual([
      ["repo.throttled", { until: throttled[0].data.until }],
      ["repo.unthrottled", { dropped: 2 }],
    ]);
    expect((await stats(repo)).meta.throttled_until).toBeUndefined();

    expect((await hub(repo).ingest("after", [fact(repo, "comment.created", 1)])).accepted).toBe(true);
    expect(kinds(await inbox(acct, "i")).at(-1)).toBe("comment.created");
  });
});

describe("check.completed", () => {
  // A check_run webhook for run `id` on SHA_A and PR 7.
  const checkRun = (action: "created" | "completed", id: number, over: Record<string, unknown> = {}) => {
    const payload = example("check_run", action);
    Object.assign(payload.check_run as object, {
      id, name: "build", head_sha: SHA_A, status: "completed", conclusion: "success", pull_requests: [{ number: 7 }], ...over,
    });
    return payload;
  };
  const watch = (repo: number, acct: number, kinds = ["check.*"]) =>
    subscribe(repo, { account: acct, inbox: "i", pr: 7, kinds, baseline: { state: "open", head_sha: SHA_A } });

  it("is sent for each check as it finishes, with check.failed for a failing one, and nothing more", async () => {
    const repo = fresh();
    const acct = fresh();
    const sub = await watch(repo, acct, ["*"]);
    // A run starting, a pending status and a check suite say nothing.
    expect((await webhook("check_run", checkRun("created", 1, { status: "queued", conclusion: null }), repo)).ingest).toBeNull();
    expect((await webhook("status", Object.assign(example("status"), { sha: SHA_A, state: "pending", context: "ci/lint" }), repo)).ingest).toBeNull();
    expect((await webhook("check_suite", example("check_suite", "completed"), repo)).ingest).toBeNull();

    const delivery = crypto.randomUUID();
    await webhook("check_run", checkRun("completed", 1), repo, delivery);
    await webhook("status", Object.assign(example("status"), { sha: SHA_A, state: "failure", context: "ci/lint", target_url: "https://ci.example/1" }), repo);
    await webhook("check_run", checkRun("completed", 2, { name: "test", conclusion: "timed_out" }), repo);

    const got = await inbox(acct, "i");
    expect(got.map((e) => [e.kind, e.data.name, e.data.conclusion])).toEqual([
      ["check.completed", "build", "success"],
      ["check.completed", "ci/lint", "failure"],
      ["check.failed", "ci/lint", "failure"],
      ["check.completed", "test", "timed_out"],
      ["check.failed", "test", "timed_out"],
    ]);
    expect(got[0]).toMatchObject({
      id: `${delivery}.0`,
      sub: sub.id,
      pr: 7,
      data: { head_sha: SHA_A, name: "build", check_run_id: 1, conclusion: "success" },
      links: { html: expect.any(String), api: expect.any(String) },
    });
    // The status, which names only a commit, goes to the PR at that head.
    expect(got[1]).toMatchObject({ pr: 7, data: { head_sha: SHA_A, status_context: "ci/lint" }, links: { html: "https://ci.example/1" } });
    // Nothing is held back for the alarm.
    expect(await runDurableObjectAlarm(hub(repo))).toBe(true);
    expect(await inbox(acct, "i")).toHaveLength(5);
  });

  it("counts a re-run, which has a new check run ID, again", async () => {
    const repo = fresh();
    const acct = fresh();
    await watch(repo, acct);
    await webhook("check_run", checkRun("completed", 11, { conclusion: "failure" }), repo);
    await webhook("check_run", checkRun("completed", 12), repo);
    expect((await inbox(acct, "i")).map((e) => [e.kind, e.data.check_run_id, e.data.conclusion])).toEqual([
      ["check.completed", 11, "failure"],
      ["check.failed", 11, "failure"],
      ["check.completed", 12, "success"],
    ]);
  });

  it("is sent once for a run created finished and then completed", async () => {
    const repo = fresh();
    const acct = fresh();
    await watch(repo, acct);
    for (const action of ["created", "completed"] as const) {
      await webhook("check_run", checkRun(action, 701, { name: "external", conclusion: "failure" }), repo);
    }
    expect((await inbox(acct, "i")).map((e) => [e.kind, e.data.check_run_id])).toEqual([["check.completed", 701], ["check.failed", 701]]);
  });

  it("takes a run completed again with a new conclusion, and ignores the same one", async () => {
    const repo = fresh();
    const acct = fresh();
    await watch(repo, acct);
    await webhook("check_run", checkRun("completed", 801), repo);
    // The App changes its mind; then says the same again.
    await webhook("check_run", checkRun("completed", 801, { conclusion: "failure" }), repo);
    await webhook("check_run", checkRun("completed", 801, { conclusion: "failure" }), repo);
    expect((await inbox(acct, "i")).map((e) => [e.kind, e.data.conclusion])).toEqual([
      ["check.completed", "success"],
      ["check.completed", "failure"],
      ["check.failed", "failure"],
    ]);
  });

  it("ignores an older completion of a run that arrives late", async () => {
    const repo = fresh();
    const acct = fresh();
    await watch(repo, acct);
    const completed = (conclusion: string, at: string) => checkRun("completed", 811, { conclusion, completed_at: at });
    await webhook("check_run", completed("failure", "2026-10-28T10:02:00Z"), repo);
    await webhook("check_run", completed("success", "2026-10-28T10:01:00Z"), repo);
    await webhook("check_run", completed("failure", "2026-10-28T10:02:00Z"), repo);
    expect((await stats(repo)).check_runs.map((r) => [r.id, r.conclusion])).toEqual([[811, "failure"]]);
    expect(kinds(await inbox(acct, "i"))).toEqual(["check.completed", "check.failed"]);
    // A newer one is news.
    await webhook("check_run", completed("success", "2026-10-28T10:03:00Z"), repo);
    expect(kinds(await inbox(acct, "i"))).toEqual(["check.completed", "check.failed", "check.completed"]);
  });

  it("forgets runs a day after it last heard of them", async () => {
    const repo = fresh();
    await watch(repo, fresh());
    await webhook("check_run", checkRun("completed", 901), repo);
    await webhook("check_run", checkRun("completed", 902), repo);
    await runInDurableObject(hub(repo), (_: RepoHub, state) => {
      state.storage.sql.exec("UPDATE check_runs SET seen_at = ? WHERE id = 901", Date.now() - 25 * 3600_000);
      state.storage.sql.exec("UPDATE meta SET v = '1' WHERE k = 'prune_at'");
    });
    await runDurableObjectAlarm(hub(repo));
    expect((await stats(repo)).check_runs.map((r) => r.id)).toEqual([902]);
  });

  it("never sends checks.completed or merge.*, and never asks GitHub", async () => {
    const repo = fresh();
    const acct = fresh();
    await subscribe(repo, { account: acct, inbox: "i", pr: 7, baseline: { state: "open", head_sha: SHA_A, base_ref: "main" } });
    await webhook("check_run", checkRun("completed", 1001), repo);
    // A push, and another PR merged into the same base.
    const push = example("pull_request", "synchronize");
    Object.assign(push, { number: 7, before: SHA_A, after: SHA_B });
    (push.pull_request as { number: number }).number = 7;
    await webhook("pull_request", push, repo);
    const merged = example("pull_request", "closed");
    Object.assign(merged.pull_request as object, { number: 8, merged: true });
    (merged.pull_request as { base: { ref: string } }).base.ref = "main";
    await webhook("pull_request", merged, repo);
    await runDurableObjectAlarm(hub(repo));
    expect(kinds(await inbox(acct, "i"))).toEqual(["check.completed", "pr.pushed"]);
    expect(fetch).not.toHaveBeenCalled();
    expect(Object.keys((await stats(repo)).meta).filter((k) => k.startsWith("merge_"))).toEqual([]);
  });
});
