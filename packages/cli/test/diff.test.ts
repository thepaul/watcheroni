import { describe, expect, it } from "vitest";
import { diff, initialMemory } from "../src/diff.ts";
import { HEAD1, HEAD2, alice, check, snap } from "./fixtures.ts";

const kinds = (events: { kind: string }[]) => events.map((e) => e.kind);

describe("diff", () => {
  it("reports nothing for what was already true", () => {
    const s = snap({ mergeable: "CONFLICTING", checks: [check("lint", { conclusion: "failure" })] });
    const { events } = diff(s, { ...s, fetchedAt: "2026-10-27T00:02:00Z" }, initialMemory(s));
    expect(events).toEqual([]);
  });

  it("reviews, review comments and issue comments", () => {
    const prev = snap();
    const next = snap({
      reviews: [{ id: 10, state: "CHANGES_REQUESTED", empty: true, at: "2026-10-27T00:01:00Z", url: "https://x/r10", author: alice }],
      reviewComments: [
        { id: 20, reviewId: 10, inReplyTo: null, path: "a.ts", line: 3, at: "2026-10-27T00:01:00Z", url: "https://x/c20", author: alice },
      ],
      threads: [{ id: "T1", resolved: false, path: "a.ts", line: 3, commentId: 20 }],
      comments: [{ id: 30, at: "2026-10-27T00:01:00Z", url: "https://x/c30", author: alice }],
    });
    const { events } = diff(prev, next, initialMemory(prev));
    expect(kinds(events)).toEqual(["review.submitted", "review_comment.created", "comment.created"]);
    expect(events[0]).toMatchObject({
      id: "local:octo/widgets#7:review.submitted:10",
      pr: 7,
      actor: alice,
      data: { review_id: 10, state: "changes_requested" },
      links: { api: "https://api.github.com/repos/octo/widgets/pulls/7/reviews/10" },
    });
    expect(events[1].data).toEqual({ comment_id: 20, review_id: 10, path: "a.ts", line: 3, in_reply_to: null });

    const resolved = diff(next, { ...next, threads: [{ ...next.threads[0], resolved: true }] }, initialMemory(next));
    expect(kinds(resolved.events)).toEqual(["thread.resolved"]);
    expect(resolved.events[0]).toMatchObject({
      data: { thread_node_id: "T1", path: "a.ts", line: 3, comment_id: 20 },
      links: { api: "https://api.github.com/repos/octo/widgets/pulls/comments/20" },
    });
    const dismissed = diff(next, { ...next, reviews: [{ ...next.reviews[0], state: "DISMISSED" }] }, initialMemory(next));
    expect(kinds(dismissed.events)).toEqual(["review.dismissed"]);
  });

  it("a \"commented\" review with no text is just its comments", () => {
    const prev = snap();
    const reply = (id: number, reviewId: number) => ({
      id, reviewId, inReplyTo: 20, path: "a.ts", line: 3, at: "2026-10-27T00:01:00Z", url: `https://x/c${id}`, author: alice,
    });
    const next = snap({
      reviews: [
        { id: 11, state: "COMMENTED", empty: true, at: "2026-10-27T00:01:00Z", url: "https://x/r11", author: alice },
        { id: 12, state: "COMMENTED", empty: false, at: "2026-10-27T00:01:00Z", url: "https://x/r12", author: alice },
        { id: 13, state: "APPROVED", empty: true, at: "2026-10-27T00:01:00Z", url: "https://x/r13", author: alice },
      ],
      reviewComments: [reply(21, 11), reply(22, 12)],
    });
    const { events } = diff(prev, next, initialMemory(prev));
    expect(events.map((e) => [e.kind, e.data.review_id])).toEqual([
      ["review.submitted", 12], ["review.submitted", 13], ["review_comment.created", 11], ["review_comment.created", 12],
    ]);
  });

  it("checks: failures, workflow runs and the rollup", () => {
    const prev = snap({ checks: [check("lint"), check("test")] });
    let memory = initialMemory(prev);
    expect(memory.rollup).toEqual({ head: HEAD1, result: "success" });

    // A push: the new head's checks start running.
    const pushed = snap({ head: HEAD2, checks: [check("lint", { done: false, conclusion: null }), check("test", { done: false, conclusion: null })] });
    let r = diff(prev, pushed, memory);
    expect(kinds(r.events)).toEqual(["pr.pushed"]);
    expect(r.events[0].data).toEqual({ before: HEAD1, after: HEAD2 });
    memory = r.memory;

    // One fails while the other runs.
    const oneFailed = snap({ head: HEAD2, checks: [check("lint", { conclusion: "failure" }), check("test", { done: false, conclusion: null })] });
    r = diff(pushed, oneFailed, memory);
    expect(kinds(r.events)).toEqual(["check.failed"]);
    expect(r.events[0].data).toMatchObject({ head_sha: HEAD2, name: "lint", conclusion: "failure", check_run_id: 4, workflow_run_id: 500 });
    memory = r.memory;

    // All done: the workflow run and the rollup, once.
    const allDone = snap({ head: HEAD2, checks: [check("lint", { conclusion: "failure" }), check("test")] });
    r = diff(oneFailed, allDone, memory);
    expect(kinds(r.events)).toEqual(["workflow.completed", "checks.completed"]);
    expect(r.events[0].data).toMatchObject({ run_id: 500, workflow: "CI", conclusion: "failure" });
    expect(r.events[1].data).toEqual({
      head_sha: HEAD2, result: "failure", failed: ["lint"], counts: { success: 1, failure: 1, cancelled: 0, skipped: 0, neutral: 0 },
    });
    memory = r.memory;
    expect(diff(allDone, { ...allDone }, memory).events).toEqual([]);

    // A re-run of lint (new check run ID) passes: the rollup changes.
    const rerun = snap({ head: HEAD2, checks: [check("lint", { key: "check_run:lint-2", checkRunId: 41 }), check("test")] });
    r = diff(allDone, rerun, memory);
    expect(kinds(r.events)).toEqual(["checks.completed"]);
    expect(r.events[0].data.result).toBe("success");
  });

  it("commit statuses", () => {
    const prev = snap({ checks: [check("ci/x", { type: "status", key: "status:ci/x", checkRunId: null, workflowRunId: null, done: false, conclusion: null })] });
    const next = snap({ checks: [check("ci/x", { type: "status", key: "status:ci/x", checkRunId: null, workflowRunId: null, conclusion: "failure" })] });
    const { events } = diff(prev, next, initialMemory(prev));
    expect(kinds(events)).toEqual(["check.failed", "checks.completed"]);
    expect(events[0].data).toMatchObject({ status_context: "ci/x" });
  });

  it("merge conflicts come and go; UNKNOWN changes nothing", () => {
    const clean = snap();
    let memory = initialMemory(clean);
    let r = diff(clean, snap({ mergeable: "UNKNOWN" }), memory);
    expect(r.events).toEqual([]);
    r = diff(clean, snap({ mergeable: "CONFLICTING" }), r.memory);
    expect(kinds(r.events)).toEqual(["merge.conflict"]);
    memory = r.memory;
    r = diff(snap({ mergeable: "CONFLICTING" }), snap({ mergeable: "UNKNOWN" }), memory);
    expect(r.events).toEqual([]);
    r = diff(snap({ mergeable: "UNKNOWN" }), snap({ mergeable: "MERGEABLE" }), r.memory);
    expect(kinds(r.events)).toEqual(["merge.clean"]);
  });

  it("ends with the PR", () => {
    const open = snap();
    const merged = snap({ state: "MERGED", mergeSha: "m".repeat(40), comments: [{ id: 1, at: "t", url: "u", author: alice }] });
    expect(kinds(diff(open, merged, initialMemory(open)).events)).toEqual(["comment.created", "pr.merged", "watch.ended"]);
    expect(kinds(diff(open, snap({ state: "CLOSED" }), initialMemory(open)).events)).toEqual(["pr.closed", "watch.ended"]);
  });

  it("PR state changes", () => {
    const prev = snap({ draft: true });
    const next = snap({ draft: false, base: "release", requested: ["bob", "team:core"] });
    expect(kinds(diff(prev, next, initialMemory(prev)).events)).toEqual([
      "pr.base_changed", "pr.ready_for_review", "pr.review_requested", "pr.review_requested",
    ]);
  });
});
