import examples from "@octokit/webhooks-examples/api.github.com/index.json";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Delivery } from "../src/account";
import type { UnsequencedEvent, WatchEvent } from "../src/protocol";
import { REPO_LIMITS, type IngestResult, type RepoHub, type RepoHubStats, type Subscription } from "../src/repo-hub";
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
  const status = (repo: number, context: string, state: "pending" | "success" | "failure") =>
    state === "pending"
      ? fact(repo, "check.started", null, { head_sha: SHA_A, name: context, status_context: context, status: "pending" })
      : fact(repo, "check.completed", null, { head_sha: SHA_A, name: context, status_context: context, conclusion: state });
  const suite = (repo: number, id: number, status: string) =>
    fact(repo, "check_suite.updated", null, { head_sha: SHA_A, suite_id: id, app_id: 99, status, conclusion: status === "completed" ? "success" : null });

  it("waits for every suite and status, then reports the result, and again when a re-run changes it", async () => {
    const repo = fresh();
    const acct = fresh();
    const sub = await subscribe(repo, { account: acct, inbox: "i", pr: 7, kinds: ["checks.completed"], baseline: { state: "open", head_sha: SHA_A } });
    const h = hub(repo);
    // Another App's suite that never runs anything is ignored.
    await h.ingest("d1", [suite(repo, 11, "queued")]);
    await h.ingest("d2", [run(repo, "check.started", 1, "build", { status: "queued" }), run(repo, "check.started", 2, "test", { status: "queued" })]);
    await h.ingest("d3", [status(repo, "ci/lint", "pending")]);
    await h.ingest("d4", [run(repo, "check.completed", 1, "build", { conclusion: "success" })]);
    await h.ingest("d5", [run(repo, "check.completed", 2, "test", { conclusion: "failure" })]);
    // Every run is done but the suite may still start more.
    expect(await inbox(acct, "i")).toEqual([]);
    await h.ingest("d6", [suite(repo, 10, "completed")]);
    // The status is still pending.
    expect(await inbox(acct, "i")).toEqual([]);
    await h.ingest("d7", [status(repo, "ci/lint", "success")]);

    const [first] = await inbox(acct, "i");
    expect(first).toMatchObject({
      id: "d7.checks.pr7",
      sub: sub.id,
      kind: "checks.completed",
      pr: 7,
      actor: null,
      links: { html: "https://github.com/octo/widgets/pull/7", api: "https://api.github.com/repos/octo/widgets/pulls/7" },
    });
    expect(first.data).toEqual({
      head_sha: SHA_A,
      result: "failure",
      failed: ["test"],
      counts: { success: 2, failure: 1, cancelled: 0, skipped: 0, neutral: 0 },
    });

    // A re-run of the failed job: only the latest run of a name counts.
    await h.ingest("d8", [run(repo, "check.started", 3, "test", { status: "queued" })]);
    await h.ingest("d9", [run(repo, "check.completed", 3, "test", { conclusion: "success" })]);
    // A late `created` for a finished run changes nothing.
    await h.ingest("d10", [run(repo, "check.started", 1, "build", { status: "queued" })]);
    const got = await inbox(acct, "i");
    expect(got.map((e) => [e.id, e.data.result])).toEqual([["d7.checks.pr7", "failure"], ["d9.checks.pr7", "success"]]);
    expect(got[1].data.counts).toEqual({ success: 3, failure: 0, cancelled: 0, skipped: 0, neutral: 0 });
    expect((await stats(repo)).rollups).toEqual([{ head_sha: SHA_A, result: "success" }]);
  });

  it("starts again on a new head, counting checks that arrived before the push", async () => {
    const repo = fresh();
    const acct = fresh();
    await subscribe(repo, { account: acct, inbox: "i", pr: 7, kinds: ["checks.completed"], baseline: { state: "open", head_sha: SHA_B } });
    await hub(repo).ingest("d1", [status(repo, "ci/lint", "failure")]);
    expect(await inbox(acct, "i")).toEqual([]);
    await hub(repo).ingest("push", [fact(repo, "pr.pushed", 7, { before: SHA_B, after: SHA_A })]);
    const got = await inbox(acct, "i");
    expect(got.map((e) => [e.id, e.data.head_sha, e.data.result, e.data.failed])).toEqual([["push.checks.pr7", SHA_A, "failure", ["ci/lint"]]]);
  });

  it("works from GitHub's check_run, check_suite and status webhooks", async () => {
    const repo = fresh();
    const acct = fresh();
    await subscribe(repo, { account: acct, inbox: "i", pr: 7, kinds: ["checks.completed"], baseline: { state: "open", head_sha: SHA_A } });
    const created = example("check_run", "created");
    Object.assign(created.check_run as object, { id: 501, head_sha: SHA_A, pull_requests: [], check_suite: { id: 77 }, app: { id: 15368 } });
    const done = example("check_run", "completed");
    Object.assign(done.check_run as object, { id: 501, name: (created.check_run as { name: string }).name, head_sha: SHA_A, conclusion: "success", pull_requests: [], check_suite: { id: 77 }, app: { id: 15368 } });
    const suiteDone = example("check_suite", "completed");
    Object.assign(suiteDone.check_suite as object, { id: 77, head_sha: SHA_A, app: { id: 15368 } });
    const pending = Object.assign(example("status"), { sha: SHA_A, state: "pending", context: "ci/x", updated_at: "2026-10-28T10:00:00Z" });
    const success = Object.assign(example("status"), { sha: SHA_A, state: "success", context: "ci/x", updated_at: "2026-10-28T10:01:00Z" });

    expect((await webhook("check_run", created, repo)).events.map((e) => e.kind)).toEqual(["check.started"]);
    expect((await webhook("status", pending, repo)).events.map((e) => e.kind)).toEqual(["check.started"]);
    await webhook("check_run", done, repo);
    expect((await webhook("check_suite", suiteDone, repo)).events.map((e) => e.kind)).toEqual(["check_suite.updated"]);
    expect(await inbox(acct, "i")).toEqual([]);
    const last = await webhook("status", success, repo);
    expect(last.ingest).toMatchObject({ accepted: true, events: 1 });
    expect((await inbox(acct, "i")).map((e) => [e.kind, e.data.result, e.data.counts])).toEqual([
      ["checks.completed", "success", { success: 2, failure: 0, cancelled: 0, skipped: 0, neutral: 0 }],
    ]);
  });
});

describe("mergeability", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // GitHub, answering `mergeable` for PR 7 with whatever `answer` holds.
  function mockGraphql(answer: { mergeable: string }) {
    const queries: { auth: string | null; query: string }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      const m = url.pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
      if (req.method === "POST" && m) {
        return Response.json({ token: `ghs_${m[1]}`, expires_at: new Date(Date.now() + 3600_000).toISOString() }, { status: 201 });
      }
      if (req.method === "POST" && url.pathname === "/graphql") {
        const { query } = (await req.json()) as { query: string };
        queries.push({ auth: req.headers.get("Authorization"), query });
        return Response.json({ data: { repository: { pr7: { state: "OPEN", mergeable: answer.mergeable, headRefOid: SHA_A, baseRefOid: SHA_B } } } });
      }
      throw new Error(`unexpected fetch ${req.method} ${req.url}`);
    });
    return queries;
  }

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
    expect(events.map((e) => e.kind)).toEqual(["pr.merged", "base.advanced"]);

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
});
