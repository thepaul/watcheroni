import { describe, expect, it } from "vitest";
import { diff } from "../src/diff.ts";
import { HEAD1, HEAD2, alice, check, snap } from "./fixtures.ts";

const kinds = (events: { kind: string }[]) => events.map((e) => e.kind);

describe("diff", () => {
  it("reports nothing for what was already true", () => {
    const s = snap({ checks: [check("lint", { conclusion: "failure" })] });
    const events = diff(s, { ...s, fetchedAt: "2026-10-27T00:02:00Z" });
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
    const events = diff(prev, next);
    expect(kinds(events)).toEqual(["review.submitted", "review_comment.created", "comment.created"]);
    expect(events[0]).toMatchObject({
      id: "local:octo/widgets#7:review.submitted:10",
      pr: 7,
      actor: alice,
      data: { review_id: 10, state: "changes_requested" },
      links: { api: "https://api.github.com/repos/octo/widgets/pulls/7/reviews/10" },
    });
    expect(events[1].data).toEqual({ comment_id: 20, review_id: 10, path: "a.ts", line: 3, in_reply_to: null });

    const resolved = diff(next, { ...next, threads: [{ ...next.threads[0], resolved: true }] });
    expect(kinds(resolved)).toEqual(["thread.resolved"]);
    expect(resolved[0]).toMatchObject({
      data: { thread_node_id: "T1", path: "a.ts", line: 3, comment_id: 20 },
      links: { api: "https://api.github.com/repos/octo/widgets/pulls/comments/20" },
    });
    const dismissed = diff(next, { ...next, reviews: [{ ...next.reviews[0], state: "DISMISSED" }] });
    expect(kinds(dismissed)).toEqual(["review.dismissed"]);
  });

  it("every review is reported, saying whether it has text", () => {
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
    const events = diff(prev, next);
    expect(events.map((e) => [e.kind, e.data.review_id, e.data.has_body])).toEqual([
      ["review.submitted", 11, false], ["review.submitted", 12, true], ["review.submitted", 13, false],
      ["review_comment.created", 11, undefined], ["review_comment.created", 12, undefined],
    ]);
  });

  it("checks: each one finishing, failures and workflow runs", () => {
    const prev = snap({ checks: [check("lint"), check("test")] });

    // A push: the new head's checks start running.
    const pushed = snap({ head: HEAD2, checks: [check("lint", { done: false, conclusion: null }), check("test", { done: false, conclusion: null })] });
    let events = diff(prev, pushed);
    expect(kinds(events)).toEqual(["pr.pushed"]);
    expect(events[0].data).toEqual({ before: HEAD1, after: HEAD2 });

    // One fails while the other runs.
    const oneFailed = snap({ head: HEAD2, checks: [check("lint", { conclusion: "failure" }), check("test", { done: false, conclusion: null })] });
    events = diff(pushed, oneFailed);
    expect(kinds(events)).toEqual(["check.completed", "check.failed"]);
    const data = { head_sha: HEAD2, name: "lint", conclusion: "failure", check_run_id: 4, workflow_run_id: 500 };
    expect(events[0]).toMatchObject({
      id: `local:octo/widgets#7:check.completed:${HEAD2}:check_run:lint:failure`,
      data,
      links: { html: "https://github.com/octo/widgets/actions/runs/500/job/lint", api: "https://api.github.com/repos/octo/widgets/check-runs/4" },
    });
    expect(events[0].data).toEqual(data);
    expect(events[1].data).toEqual(data);

    // The other finishes, and with it the workflow run.
    const allDone = snap({ head: HEAD2, checks: [check("lint", { conclusion: "failure" }), check("test")] });
    events = diff(oneFailed, allDone);
    expect(kinds(events)).toEqual(["check.completed", "workflow.completed"]);
    expect(events[0].data).toMatchObject({ name: "test", conclusion: "success" });
    expect(events[1].data).toMatchObject({ run_id: 500, workflow: "CI", conclusion: "failure" });
    expect(diff(allDone, { ...allDone })).toEqual([]);

    // A re-run of lint is a new check run (in the same workflow run): it
    // counts again when it finishes.
    const rerun = snap({ head: HEAD2, checks: [check("lint", { key: "check_run:lint-2", checkRunId: 41, done: false, conclusion: null }), check("test")] });
    expect(diff(allDone, rerun)).toEqual([]);
    const rerunDone = snap({ head: HEAD2, checks: [check("lint", { key: "check_run:lint-2", checkRunId: 41 }), check("test")] });
    events = diff(rerun, rerunDone);
    expect(kinds(events)).toEqual(["check.completed", "workflow.completed"]);
    expect(events[0].data).toMatchObject({ name: "lint", check_run_id: 41, conclusion: "success" });

    // A run completed again with another conclusion counts; the same one doesn't.
    const changed = snap({ head: HEAD2, checks: [check("lint", { key: "check_run:lint-2", checkRunId: 41, conclusion: "failure" }), check("test")] });
    expect(kinds(diff(rerunDone, changed))).toEqual(["check.completed", "check.failed"]);
    expect(diff(changed, { ...changed })).toEqual([]);
  });

  it("commit statuses", () => {
    const prev = snap({ checks: [check("ci/x", { type: "status", key: "status:ci/x", checkRunId: null, workflowRunId: null, done: false, conclusion: null })] });
    const next = snap({ checks: [check("ci/x", { type: "status", key: "status:ci/x", checkRunId: null, workflowRunId: null, conclusion: "failure", url: "https://ci.example/1" })] });
    const events = diff(prev, next);
    expect(kinds(events)).toEqual(["check.completed", "check.failed"]);
    expect(events[0].data).toEqual({ head_sha: HEAD1, name: "ci/x", status_context: "ci/x", conclusion: "failure" });
    expect(events[0].links).toEqual({ html: "https://ci.example/1" });
  });

  it("ends with the PR", () => {
    const open = snap();
    const merged = snap({ state: "MERGED", mergeSha: "m".repeat(40), comments: [{ id: 1, at: "t", url: "u", author: alice }] });
    expect(kinds(diff(open, merged))).toEqual(["comment.created", "pr.merged", "watch.ended"]);
    expect(kinds(diff(open, snap({ state: "CLOSED" })))).toEqual(["pr.closed", "watch.ended"]);
  });

  it("PR state changes", () => {
    const prev = snap({ draft: true });
    const next = snap({ draft: false, base: "release", requested: ["bob", "team:core"] });
    expect(kinds(diff(prev, next))).toEqual([
      "pr.base_changed", "pr.ready_for_review", "pr.review_requested", "pr.review_requested",
    ]);
  });
});
