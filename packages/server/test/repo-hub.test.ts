import examples from "@octokit/webhooks-examples/api.github.com/index.json";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    for (const internal of ["check.completed", "check.started", "check_suite.updated", "base.advanced"]) expect(seen).not.toContain(internal);
    for (const k of ["pr.opened", "pr.closed", "review.submitted", "review_comment.created", "comment.created", "workflow.completed", "issue.opened"]) {
      expect(seen).toContain(k);
    }
  });
});

describe("matching", () => {
  it("matches checks and statuses with no PR by the PR's head SHA", async () => {
    const repo = fresh();
    const acct = fresh();
    const other = fresh();
    // Only check.failed: the lone status would finish the rollup.
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
    expect((await webhook("status", now, repo)).ingest).toMatchObject({ accepted: true, events: 1 });
    // `pr.pushed` was filtered out by kinds; only the new head's status arrives.
    expect((await inbox(acct, "i")).map((e) => e.data.name)).toEqual(["new"]);
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
  // branches: prs.author (ticket 007) or check tables (ticket 003).
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
  };

  for (const [name, shape] of Object.entries(shapes)) {
    it(`brings ${name} to the current schema, keeping its rows`, async () => {
      const repo = fresh();
      await subscribe(repo, { account: fresh(), inbox: "i", pr: 1 });
      await runInDurableObject(hub(repo), (_: RepoHub, state) => {
        const sql = state.storage.sql;
        sql.exec("DROP TABLE subscriptions");
        sql.exec("DROP TABLE prs");
        sql.exec("DROP TABLE checks");
        sql.exec("DROP TABLE rollups");
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
        expect(meta("schema_version")).toBe("5");
        expect(meta("tracks_all_prs")).toBe("1");
        const columns = sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('prs')").toArray().map((c) => c.name);
        expect(columns).toEqual(expect.arrayContaining(["author", "seen_at"]));
        expect(sql.exec("SELECT number, head_sha, author FROM prs").toArray()).toEqual([{ number: 5, head_sha: SHA_A, author: shape.author ?? null }]);
        expect(sql.exec("SELECT id FROM subscriptions ORDER BY id").toArray()).toEqual([{ id: "sub_a" }, { id: "sub_b" }]);
        // The derived events' caches, in their current shape and empty.
        const cols = (t: string) => sql.exec<{ name: string }>("SELECT name FROM pragma_table_info(?)", t).toArray().map((c) => c.name);
        expect(cols("checks")).toEqual(expect.arrayContaining(["ord", "seen_at"]));
        expect(cols("rollups")).toEqual(["pr", "head_sha", "fingerprint", "settle_at"]);
        expect(sql.exec("SELECT 1 FROM checks").toArray()).toEqual([]);
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

describe("checks.completed", () => {
  const run = (repo: number, kind: "check.started" | "check.completed", id: number, name: string, extra: UnsequencedEvent["data"] = {}) =>
    fact(repo, kind, null, { head_sha: SHA_A, name, check_run_id: id, suite_id: 10, app_id: 15368, ...extra });
  const status = (repo: number, context: string, state: "pending" | "success" | "failure", sha = SHA_A, id?: number) =>
    state === "pending"
      ? fact(repo, "check.started", null, { head_sha: sha, name: context, status_context: context, status: "pending", status_id: id ?? null })
      : fact(repo, "check.completed", null, { head_sha: sha, name: context, status_context: context, conclusion: state, status_id: id ?? null });
  const suite = (repo: number, id: number, status: string) =>
    fact(repo, "check_suite.updated", null, { head_sha: SHA_A, suite_id: id, app_id: 99, status, conclusion: status === "completed" ? "success" : null });
  const watch = (repo: number, acct: number, head = SHA_A) =>
    subscribe(repo, { account: acct, inbox: "i", pr: 7, kinds: ["checks.completed"], baseline: { state: "open", head_sha: head } });
  const counts = (o: Partial<Record<string, number>>) => ({ success: 0, failure: 0, cancelled: 0, skipped: 0, neutral: 0, ...o });

  // Runs the alarm as if the settle delay had passed. Returns whether a
  // send was pending.
  async function settle(repo: number): Promise<boolean> {
    const pending = await runInDurableObject(hub(repo), (_: RepoHub, state) =>
      state.storage.sql.exec("UPDATE rollups SET settle_at = 1 WHERE settle_at IS NOT NULL").rowsWritten > 0,
    );
    await runDurableObjectAlarm(hub(repo));
    return pending;
  }

  it("waits for every suite and status, settles, then reports, and again when a re-run changes it", async () => {
    const repo = fresh();
    const acct = fresh();
    const sub = await watch(repo, acct);
    const h = hub(repo);
    // Another App's suite that never runs anything is ignored.
    await h.ingest("d1", [suite(repo, 11, "queued")]);
    await h.ingest("d2", [run(repo, "check.started", 1, "build", { status: "queued" }), run(repo, "check.started", 2, "test", { status: "queued" })]);
    await h.ingest("d3", [status(repo, "ci/lint", "pending")]);
    await h.ingest("d4", [run(repo, "check.completed", 1, "build", { conclusion: "success" })]);
    await h.ingest("d5", [run(repo, "check.completed", 2, "test", { conclusion: "failure" })]);
    // Every run is done but the suite may still start more.
    expect(await settle(repo)).toBe(false);
    await h.ingest("d6", [suite(repo, 10, "completed")]);
    // The status is still pending.
    expect(await settle(repo)).toBe(false);
    await h.ingest("d7", [status(repo, "ci/lint", "success")]);
    // Finished, but sent only after the settle delay.
    const [pending] = (await stats(repo)).rollups;
    expect(pending.settle_at! - Date.now()).toBeGreaterThan(15_000);
    expect(await inbox(acct, "i")).toEqual([]);
    expect(await settle(repo)).toBe(true);

    const [first] = await inbox(acct, "i");
    expect(first).toMatchObject({
      sub: sub.id,
      kind: "checks.completed",
      pr: 7,
      actor: null,
      links: { html: "https://github.com/octo/widgets/pull/7", api: "https://api.github.com/repos/octo/widgets/pulls/7" },
    });
    expect(first.id).toMatch(new RegExp(`^repo:${repo}\\.pr7\\.checks\\.\\d+$`));
    expect(first.data).toEqual({ head_sha: SHA_A, result: "failure", failed: ["test"], counts: counts({ success: 2, failure: 1 }) });

    // A re-run of the failed job: only the latest run of a name counts.
    await h.ingest("d8", [run(repo, "check.started", 3, "test", { status: "queued" })]);
    await h.ingest("d9", [run(repo, "check.completed", 3, "test", { conclusion: "success" })]);
    // A late `created` for a finished run changes nothing.
    await h.ingest("d10", [run(repo, "check.started", 1, "build", { status: "queued" })]);
    expect(await settle(repo)).toBe(true);
    // Nothing new: nothing to send.
    await h.ingest("d11", [status(repo, "ci/lint", "success")]);
    expect(await settle(repo)).toBe(false);
    const got = await inbox(acct, "i");
    expect(got.map((e) => e.data.result)).toEqual(["failure", "success"]);
    expect(got[1].data.counts).toEqual(counts({ success: 3 }));
  });

  it("reports again when checks that appear later finish", async () => {
    const repo = fresh();
    const acct = fresh();
    await watch(repo, acct);
    // A quick status finishes before Actions has created any runs.
    await hub(repo).ingest("cla", [status(repo, "cla", "success")]);
    expect(await settle(repo)).toBe(true);
    await hub(repo).ingest("r1", [run(repo, "check.started", 1, "build", { status: "queued" })]);
    await hub(repo).ingest("r2", [run(repo, "check.completed", 1, "build", { conclusion: "success" })]);
    await hub(repo).ingest("s", [suite(repo, 10, "completed")]);
    expect(await settle(repo)).toBe(true);
    expect((await inbox(acct, "i")).map((e) => [e.data.result, e.data.counts])).toEqual([
      ["success", counts({ success: 1 })],
      ["success", counts({ success: 2 })],
    ]);
  });

  it("doesn't send a rollup that stops being finished before it settles", async () => {
    const repo = fresh();
    const acct = fresh();
    await watch(repo, acct);
    await hub(repo).ingest("cla", [status(repo, "cla", "success")]);
    await hub(repo).ingest("r1", [run(repo, "check.started", 1, "build", { status: "queued" })]);
    expect(await settle(repo)).toBe(false);
    await hub(repo).ingest("r2", [run(repo, "check.completed", 1, "build", { conclusion: "failure" }), suite(repo, 10, "completed")]);
    expect(await settle(repo)).toBe(true);
    expect((await inbox(acct, "i")).map((e) => [e.data.result, e.data.counts])).toEqual([["failure", counts({ success: 1, failure: 1 })]]);
  });

  it("starts again on a new head, counting checks from before the push, and after a force-push back", async () => {
    const repo = fresh();
    const acct = fresh();
    await watch(repo, acct, SHA_B);
    await hub(repo).ingest("a", [status(repo, "ci/lint", "success", SHA_A)]);
    await hub(repo).ingest("b", [status(repo, "ci/lint", "failure", SHA_B)]);
    expect(await settle(repo)).toBe(true);
    await hub(repo).ingest("push", [fact(repo, "pr.pushed", 7, { before: SHA_B, after: SHA_A })]);
    expect(await settle(repo)).toBe(true);
    // Back to the first head: its rollup is news again, as in the CLI.
    await hub(repo).ingest("back", [fact(repo, "pr.pushed", 7, { before: SHA_A, after: SHA_B })]);
    expect(await settle(repo)).toBe(true);
    expect((await inbox(acct, "i")).map((e) => [e.data.head_sha, e.data.result])).toEqual([
      [SHA_B, "failure"],
      [SHA_A, "success"],
      [SHA_B, "failure"],
    ]);
  });

  it("keeps the newest of out-of-order facts", async () => {
    const repo = fresh();
    const acct = fresh();
    await watch(repo, acct);
    const at = "2026-10-28T10:00:00Z";
    const h = hub(repo);
    // The run's completion arrives before its creation, and the suite's
    // completion before the run that first names the suite.
    await h.ingest("d1", [run(repo, "check.completed", 5, "build", { conclusion: "success", suite_id: 20 })]);
    await h.ingest("d2", [run(repo, "check.started", 5, "build", { status: "queued", suite_id: 20 })]);
    await h.ingest("d3", [{ ...fact(repo, "check_suite.updated", null, { head_sha: SHA_A, suite_id: 21, status: "completed", conclusion: "success" }), at }]);
    await h.ingest("d4", [run(repo, "check.completed", 6, "lint", { conclusion: "success", suite_id: 21 })]);
    await h.ingest("d5", [suite(repo, 20, "completed")]);
    // A status's success and pending in the same second, the other way
    // round: the higher ID wins.
    await h.ingest("d6", [{ ...status(repo, "ci/x", "success", SHA_A, 11), at }]);
    await h.ingest("d7", [{ ...status(repo, "ci/x", "pending", SHA_A, 10), at }]);
    expect(await settle(repo)).toBe(true);
    expect((await inbox(acct, "i")).map((e) => e.data.counts)).toEqual([counts({ success: 3 })]);
  });

  it("counts a run created already finished, and never a missing conclusion as success", async () => {
    const repo = fresh();
    const acct = fresh();
    await watch(repo, acct);
    const created = example("check_run", "created");
    Object.assign(created.check_run as object, {
      id: 601, name: "external", head_sha: SHA_A, status: "completed", conclusion: "failure",
      pull_requests: [], check_suite: { id: 88 }, app: { id: 7 },
    });
    expect((await webhook("check_run", created, repo)).events.map((e) => e.kind)).toEqual(["check.completed", "check.failed"]);
    await hub(repo).ingest("d1", [run(repo, "check.completed", 602, "odd", { conclusion: null, suite_id: 88 })]);
    await hub(repo).ingest("d2", [{ ...suite(repo, 88, "completed"), at: new Date(Date.now() + 1000).toISOString() }]);
    expect(await settle(repo)).toBe(true);
    expect((await inbox(acct, "i")).map((e) => [e.data.result, e.data.failed, e.data.counts])).toEqual([
      ["failure", ["external"], counts({ failure: 1, neutral: 1 })],
    ]);
  });

  it("works from GitHub's check_run, check_suite and status webhooks", async () => {
    const repo = fresh();
    const acct = fresh();
    await watch(repo, acct);
    const created = example("check_run", "created");
    Object.assign(created.check_run as object, { id: 501, head_sha: SHA_A, pull_requests: [], check_suite: { id: 77 }, app: { id: 15368 } });
    const done = example("check_run", "completed");
    Object.assign(done.check_run as object, { id: 501, name: (created.check_run as { name: string }).name, head_sha: SHA_A, conclusion: "success", pull_requests: [], check_suite: { id: 77 }, app: { id: 15368 } });
    const suiteDone = example("check_suite", "completed");
    Object.assign(suiteDone.check_suite as object, { id: 77, head_sha: SHA_A, app: { id: 15368 } });
    const pending = Object.assign(example("status"), { id: 1, sha: SHA_A, state: "pending", context: "ci/x", updated_at: "2026-10-28T10:00:00Z" });
    const success = Object.assign(example("status"), { id: 2, sha: SHA_A, state: "success", context: "ci/x", updated_at: "2026-10-28T10:00:00Z" });

    expect((await webhook("check_run", created, repo)).events.map((e) => e.kind)).toEqual(["check.started"]);
    expect((await webhook("status", pending, repo)).events.map((e) => e.kind)).toEqual(["check.started"]);
    await webhook("check_run", done, repo);
    expect((await webhook("check_suite", suiteDone, repo)).events.map((e) => e.kind)).toEqual(["check_suite.updated"]);
    await webhook("status", success, repo);
    expect(await settle(repo)).toBe(true);
    expect((await inbox(acct, "i")).map((e) => [e.kind, e.data.result, e.data.counts])).toEqual([
      ["checks.completed", "success", counts({ success: 2 })],
    ]);
  });

  it("keeps checks that finish while the repo is throttled", async () => {
    const repo = fresh();
    const acct = fresh();
    await watch(repo, acct);
    await hub(repo).ingest("r1", [run(repo, "check.started", 1, "build", { status: "queued" })]);
    await runInDurableObject(hub(repo), (_: RepoHub, state) => {
      state.storage.sql.exec("INSERT INTO buckets (name, tokens, updated_at) VALUES ('ingest', 0, ?)", Date.now());
    });
    expect(await hub(repo).ingest("r2", [run(repo, "check.completed", 1, "build", { conclusion: "success" })])).toMatchObject({ reason: "throttled" });
    await hub(repo).ingest("s", [suite(repo, 10, "completed")]);
    expect(await settle(repo)).toBe(true);
    expect((await inbox(acct, "i")).map((e) => [e.kind, e.data.result ?? null])).toEqual([["repo.throttled", null], ["checks.completed", "success"]]);
  });

  it("sends check.failed once for a run created finished and then completed", async () => {
    const repo = fresh();
    const acct = fresh();
    await subscribe(repo, { account: acct, inbox: "i", pr: 7, kinds: ["check.failed"], baseline: { state: "open", head_sha: SHA_A } });
    for (const action of ["created", "completed"]) {
      const payload = example("check_run", action);
      Object.assign(payload.check_run as object, {
        id: 701, name: "external", head_sha: SHA_A, status: "completed", conclusion: "failure",
        pull_requests: [{ number: 7 }], check_suite: { id: 89 }, app: { id: 7 },
      });
      await webhook("check_run", payload, repo);
    }
    expect((await inbox(acct, "i")).map((e) => [e.kind, e.data.check_run_id])).toEqual([["check.failed", 701]]);
  });

  it("takes a run completed again with a new conclusion, and ignores the same one", async () => {
    const repo = fresh();
    const acct = fresh();
    await subscribe(repo, { account: acct, inbox: "i", pr: 7, kinds: ["check.failed", "checks.completed"], baseline: { state: "open", head_sha: SHA_A } });
    const completed = (conclusion: string) => {
      const payload = example("check_run", "completed");
      Object.assign(payload.check_run as object, {
        id: 801, name: "external", head_sha: SHA_A, status: "completed", conclusion,
        pull_requests: [{ number: 7 }], check_suite: { id: 90 }, app: { id: 7 },
      });
      return payload;
    };
    const suiteDone = { ...fact(repo, "check_suite.updated", null, { head_sha: SHA_A, suite_id: 90, status: "completed", conclusion: "success" }), at: "2099-01-01T00:00:00Z" };
    await webhook("check_run", completed("success"), repo);
    await hub(repo).ingest("s", [suiteDone]);
    expect(await settle(repo)).toBe(true);
    // The App changes its mind; then says the same again.
    await webhook("check_run", completed("failure"), repo);
    await webhook("check_run", completed("failure"), repo);
    expect(await settle(repo)).toBe(true);
    expect((await inbox(acct, "i")).map((e) => [e.kind, e.data.result ?? e.data.conclusion])).toEqual([
      ["checks.completed", "success"],
      ["check.failed", "failure"],
      ["checks.completed", "failure"],
    ]);
  });

  it("keeps the latest completion of a run when they arrive out of order", async () => {
    const repo = fresh();
    const acct = fresh();
    await subscribe(repo, { account: acct, inbox: "i", pr: 7, kinds: ["check.failed"], baseline: { state: "open", head_sha: SHA_A } });
    const completed = (conclusion: string, completedAt: string) => {
      const payload = example("check_run", "completed");
      Object.assign(payload.check_run as object, {
        id: 811, name: "external", head_sha: SHA_A, status: "completed", conclusion, completed_at: completedAt,
        pull_requests: [{ number: 7 }], check_suite: { id: 91 }, app: { id: 7 },
      });
      return payload;
    };
    await webhook("check_run", completed("failure", "2026-10-28T10:02:00Z"), repo);
    // An older completion arrives late: it changes nothing.
    await webhook("check_run", completed("success", "2026-10-28T10:01:00Z"), repo);
    await webhook("check_run", completed("failure", "2026-10-28T10:02:00Z"), repo);
    const rows = (await stats(repo)).checks.filter((c) => c.kind === "run");
    expect(rows.map((c) => c.conclusion)).toEqual(["failure"]);
    expect((await inbox(acct, "i")).map((e) => e.kind)).toEqual(["check.failed"]);
    // A newer one does.
    await webhook("check_run", completed("success", "2026-10-28T10:03:00Z"), repo);
    expect((await stats(repo)).checks.filter((c) => c.kind === "run").map((c) => c.conclusion)).toEqual(["success"]);
  });

  it("follows a push made while the repo is throttled", async () => {
    const repo = fresh();
    const acct = fresh();
    await watch(repo, acct, SHA_B);
    await runInDurableObject(hub(repo), (_: RepoHub, state) => {
      state.storage.sql.exec("INSERT INTO buckets (name, tokens, updated_at) VALUES ('ingest', 0, ?)", Date.now());
    });
    expect(await hub(repo).ingest("push", [fact(repo, "pr.pushed", 7, { before: SHA_B, after: SHA_A })])).toMatchObject({ reason: "throttled" });
    expect((await stats(repo)).prs).toMatchObject([{ number: 7, head_sha: SHA_A }]);
    await hub(repo).ingest("r1", [run(repo, "check.started", 1, "build", { status: "queued" })]);
    await hub(repo).ingest("r2", [run(repo, "check.completed", 1, "build", { conclusion: "success" })]);
    await hub(repo).ingest("s", [suite(repo, 10, "completed")]);
    expect(await settle(repo)).toBe(true);
    // The settled rollup comes from the alarm, throttle or not.
    expect((await inbox(acct, "i")).map((e) => [e.kind, e.data.head_sha ?? null])).toEqual([["repo.throttled", null], ["checks.completed", SHA_A]]);
  });

  it("waits for the rollup to stay unchanged for the whole settle delay", async () => {
    const repo = fresh();
    await watch(repo, fresh());
    const settleAt = async () => (await stats(repo)).rollups[0].settle_at!;
    await hub(repo).ingest("a", [status(repo, "cla", "success")]);
    const first = await settleAt();
    await new Promise((r) => setTimeout(r, 20));
    await hub(repo).ingest("b", [status(repo, "lint", "success")]);
    expect(await settleAt()).toBeGreaterThan(first);
  });

  it("doesn't charge deliveries that only start checks to the ingest limit", async () => {
    const repo = fresh();
    await watch(repo, fresh());
    await runInDurableObject(hub(repo), (_: RepoHub, state) => {
      state.storage.sql.exec("INSERT INTO buckets (name, tokens, updated_at) VALUES ('ingest', 0, ?)", Date.now());
    });
    expect(await hub(repo).ingest("d1", [run(repo, "check.started", 1, "build"), suite(repo, 10, "queued")])).toMatchObject({ accepted: true });
    expect(await hub(repo).ingest("d2", [status(repo, "ci/x", "failure")])).toMatchObject({ accepted: false, reason: "throttled" });
  });
});

describe("mergeability", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // GitHub: installation tokens (or `tokenStatus`), and GraphQL answering
  // with `graphql()`.
  function mockGitHub(graphql: () => Response, tokenStatus = 201) {
    const queries: { auth: string | null; query: string }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      const m = url.pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
      if (req.method === "POST" && m) {
        if (tokenStatus !== 201) return Response.json({ message: "nope" }, { status: tokenStatus });
        return Response.json({ token: `ghs_${m[1]}`, expires_at: new Date(Date.now() + 3600_000).toISOString() }, { status: 201 });
      }
      if (req.method === "POST" && url.pathname === "/graphql") {
        const { query } = (await req.json()) as { query: string };
        queries.push({ auth: req.headers.get("Authorization"), query });
        return graphql();
      }
      throw new Error(`unexpected fetch ${req.method} ${req.url}`);
    });
    return queries;
  }

  // GitHub, answering `mergeable` for PR 7 with whatever `answer` holds.
  const mockGraphql = (answer: { mergeable: string }) =>
    mockGitHub(() => Response.json({ data: { repository: { pr7: { state: "OPEN", mergeable: answer.mergeable, headRefOid: SHA_A, baseRefOid: SHA_B } } } }));

  const watchWithInstallation = (repo: number, acct = fresh(), extra: Record<string, unknown> = {}) =>
    subscribe(repo, {
      account: acct, inbox: "i", pr: 7, installation_id: fresh(),
      baseline: { state: "open", head_sha: SHA_A, base_ref: "main", mergeable: "mergeable" }, ...extra,
    });
  const apiTokens = (repo: number) =>
    runInDurableObject(hub(repo), (_: RepoHub, state) =>
      state.storage.sql.exec<{ tokens: number }>("SELECT tokens FROM buckets WHERE name = 'api'").toArray()[0]?.tokens ?? null,
    );

  const dueNow = (repo: number) =>
    runInDurableObject(hub(repo), (_: RepoHub, state) => {
      state.storage.sql.exec("UPDATE meta SET v = '1' WHERE k = 'merge_check_at'");
    });
  const checkAt = async (repo: number) => Number((await stats(repo)).meta.merge_check_at) - Date.now();

  it("reports a conflict when another PR merges into the base, and clean once it's fixed", async () => {
    const repo = fresh();
    const acct = fresh();
    const inst = fresh();
    const answer = { mergeable: "CONFLICTING" };
    const queries = mockGraphql(answer);
    const sub = await subscribe(repo, {
      account: acct, inbox: "i", pr: 7, installation_id: inst, kinds: ["merge.*"],
      baseline: { state: "open", head_sha: SHA_A, base_ref: "main", mergeable: "mergeable" },
    });
    // With a definite baseline, the next check is the periodic one.
    expect(await checkAt(repo)).toBeGreaterThan(14 * 60_000);

    // A merge into another branch doesn't count; one into main does.
    const other = example("pull_request", "closed");
    Object.assign(other.pull_request as object, { number: 9, merged: true, base: { ref: "release" } });
    await webhook("pull_request", other, repo);
    expect(await checkAt(repo)).toBeGreaterThan(14 * 60_000);
    const merged = example("pull_request", "closed");
    Object.assign(merged.pull_request as object, { number: 9, merged: true, base: { ref: "main" } });
    // The webhook names its installation too, and that's the one used.
    merged.installation = { id: inst };
    const { events } = await webhook("pull_request", merged, repo);
    expect(events.map((e) => e.kind)).toEqual(["pr.merged", "base.advanced", "pr.seen"]);

    // Due at once, so the alarm runs by itself.
    await eventually(async () => expect(await inbox(acct, "i")).toHaveLength(1));
    expect(queries).toHaveLength(1);
    expect(queries[0].auth).toBe(`Bearer ghs_${inst}`);
    expect(queries[0].query).toContain("pr7: pullRequest(number: 7)");
    const [conflict] = await inbox(acct, "i");
    expect(conflict).toMatchObject({ kind: "merge.conflict", sub: sub.id, pr: 7, actor: null, data: { head_sha: SHA_A, base_sha: SHA_B } });
    expect(conflict.id).toMatch(new RegExp(`^repo:${repo}\\.pr7\\.conflict\\.\\d+$`));
    expect((await stats(repo)).prs).toMatchObject([{ number: 7, mergeable: "conflicting" }]);
    expect(await checkAt(repo)).toBeGreaterThan(14 * 60_000);

    // Still conflicting: nothing new.
    await dueNow(repo);
    await runDurableObjectAlarm(hub(repo));
    expect(queries).toHaveLength(2);
    expect(await inbox(acct, "i")).toHaveLength(1);

    answer.mergeable = "MERGEABLE";
    await dueNow(repo);
    await runDurableObjectAlarm(hub(repo));
    expect((await inbox(acct, "i")).map((e) => [e.kind, e.data])).toEqual([
      ["merge.conflict", { head_sha: SHA_A, base_sha: SHA_B }],
      ["merge.clean", { head_sha: SHA_A, base_sha: SHA_B }],
    ]);
  });

  it("asks again after 10, 30 and 90 seconds while GitHub says UNKNOWN", async () => {
    const repo = fresh();
    const acct = fresh();
    const answer = { mergeable: "UNKNOWN" };
    const queries = mockGraphql(answer);
    await subscribe(repo, {
      account: acct, inbox: "i", pr: 7, installation_id: fresh(),
      baseline: { state: "open", head_sha: SHA_B, base_ref: "main", mergeable: "mergeable" },
    });
    await hub(repo).ingest("push", [fact(repo, "pr.pushed", 7, { before: SHA_B, after: SHA_A })]);
    // Due at once, so the first check runs by itself.
    await eventually(async () => expect((await stats(repo)).meta.merge_unknown_retries).toBe("1"));
    for (const [i, wait] of [10_000, 30_000, 90_000, 15 * 60_000].entries()) {
      if (i) {
        await dueNow(repo);
        await runDurableObjectAlarm(hub(repo));
      }
      const left = await checkAt(repo);
      expect(left).toBeGreaterThan(wait - 2000);
      expect(left).toBeLessThanOrEqual(wait);
    }
    expect(queries).toHaveLength(4);
    answer.mergeable = "CONFLICTING";
    await dueNow(repo);
    await runDurableObjectAlarm(hub(repo));
    expect(kinds(await inbox(acct, "i"))).toEqual(["pr.pushed", "merge.conflict"]);
  });

  it("waits when the repo's API budget is spent", async () => {
    const repo = fresh();
    const queries = mockGraphql({ mergeable: "CONFLICTING" });
    await subscribe(repo, {
      account: fresh(), inbox: "i", pr: 7, installation_id: fresh(),
      baseline: { state: "open", head_sha: SHA_A, base_ref: "main" },
    });
    await runInDurableObject(hub(repo), (_: RepoHub, state) => {
      state.storage.sql.exec("INSERT INTO buckets (name, tokens, updated_at) VALUES ('api', 0, ?)", Date.now());
    });
    await dueNow(repo);
    await runDurableObjectAlarm(hub(repo));
    expect(queries).toEqual([]);
    // One call back in the bucket: 30 s at 120 an hour.
    const left = await checkAt(repo);
    expect(left).toBeGreaterThan(25_000);
    expect(left).toBeLessThanOrEqual(30_000);
  });

  for (const [what, answer] of [
    ["a GraphQL error", () => Response.json({ data: null, errors: [{ message: "Something went wrong" }] })],
    ["a non-200 answer", () => new Response("bad gateway", { status: 502 })],
    ["a body that isn't JSON", () => new Response("<html>", { status: 200 })],
  ] as const) {
    it(`retries in a minute after ${what}, keeping the alarm's other work`, async () => {
      const repo = fresh();
      const acct = fresh();
      const queries = mockGitHub(answer);
      await watchWithInstallation(repo, acct);
      // The same alarm also ends a subscription whose verification lapsed.
      await subscribe(repo, { account: acct, inbox: "j", pr: 7, verified_until: Date.now() + 3600_000 });
      await runInDurableObject(hub(repo), (_: RepoHub, state) => {
        state.storage.sql.exec("UPDATE subscriptions SET verified_until = 1 WHERE inbox = 'j'");
      });
      await dueNow(repo);
      await runDurableObjectAlarm(hub(repo));
      expect(queries).toHaveLength(1);
      expect(kinds(await inbox(acct, "j"))).toEqual(["watch.unverified"]);
      const left = await checkAt(repo);
      expect(left).toBeGreaterThan(55_000);
      expect(left).toBeLessThanOrEqual(60_000);
    });
  }

  it("retries in a minute when there's no installation token, without spending the repo's budget", async () => {
    const repo = fresh();
    const queries = mockGitHub(() => Response.json({}), 500);
    await watchWithInstallation(repo);
    await dueNow(repo);
    await runDurableObjectAlarm(hub(repo));
    expect(queries).toEqual([]);
    expect(await apiTokens(repo)).toBeNull();
    expect(await checkAt(repo)).toBeGreaterThan(55_000);
  });

  it("keeps a check asked for while one is waiting on GitHub", async () => {
    const repo = fresh();
    const acct = fresh();
    const queries = mockGraphql({ mergeable: "UNKNOWN" });
    await watchWithInstallation(repo, acct);
    const push = fact(repo, "pr.pushed", 7, { before: SHA_A, after: SHA_B });
    type Hooks = { installationToken?: (id: number, calls: number) => Promise<unknown> };
    await runInDurableObject(hub(repo), (instance: RepoHub, state) => {
      state.storage.sql.exec("INSERT INTO meta (k, v) VALUES ('merge_unknown_retries', '2')");
      // A push arrives while the check waits for its token.
      (instance as unknown as Hooks).installationToken = async () => {
        await instance.ingest("push", [push]);
        return { ok: true, token: "ghs_test" };
      };
    });
    await dueNow(repo);
    await runDurableObjectAlarm(hub(repo));
    // The push's check runs next (by itself, as it's due), with its
    // retries started again.
    await eventually(async () => {
      expect(queries).toHaveLength(2);
      expect((await stats(repo)).meta.merge_unknown_retries).toBe("1");
    });
    expect(kinds(await inbox(acct, "i"))).toEqual(["pr.pushed"]);
  });
});
