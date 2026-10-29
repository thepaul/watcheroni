import examples from "@octokit/webhooks-examples/api.github.com/index.json";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
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

  it("takes every example, and never delivers check.completed", async () => {
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
    expect(seen).not.toContain("check.completed");
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
    const sub = await subscribe(repo, { account: acct, inbox: "i", pr: 7, baseline: { state: "open", head_sha: SHA_A } });
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
