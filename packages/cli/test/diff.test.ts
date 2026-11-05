import { describe, expect, it } from "vitest";
import { diff, unknownRuns } from "../src/diff.ts";
import type { Snapshot } from "../src/snapshot.ts";
import { HEAD1, HEAD2, alice, check, run, snap } from "./fixtures.ts";

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

  it("checks: each one finishing, and failures", () => {
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

    // The other finishes.
    const allDone = snap({ head: HEAD2, checks: [check("lint", { conclusion: "failure" }), check("test")] });
    events = diff(oneFailed, allDone);
    expect(kinds(events)).toEqual(["check.completed"]);
    expect(events[0].data).toMatchObject({ name: "test", conclusion: "success" });
    expect(diff(allDone, { ...allDone })).toEqual([]);

    // A re-run of lint is a new check run (in the same workflow run): it
    // counts again when it finishes.
    const rerun = snap({ head: HEAD2, checks: [check("lint", { key: "check_run:lint-2", checkRunId: 41, done: false, conclusion: null }), check("test")] });
    expect(diff(allDone, rerun)).toEqual([]);
    const rerunDone = snap({ head: HEAD2, checks: [check("lint", { key: "check_run:lint-2", checkRunId: 41 }), check("test")] });
    events = diff(rerun, rerunDone);
    expect(kinds(events)).toEqual(["check.completed"]);
    expect(events[0].data).toMatchObject({ name: "lint", check_run_id: 41, conclusion: "success" });

    // A run completed again with another conclusion counts; the same one doesn't.
    const changed = snap({ head: HEAD2, checks: [check("lint", { key: "check_run:lint-2", checkRunId: 41, conclusion: "failure" }), check("test")] });
    expect(kinds(diff(rerunDone, changed))).toEqual(["check.completed", "check.failed"]);
    expect(diff(changed, { ...changed })).toEqual([]);
  });

  it("workflow runs: finished when GitHub says so, not when their jobs so far are", () => {
    // `build` and `lint` are done; `deploy` (needs: build) isn't created yet.
    // GitHub still has the run in progress, so nothing is said about it.
    const firstJobs = [check("build"), check("lint")];
    const running = snap({ checks: firstJobs, workflowRuns: [run({ done: false, conclusion: null })] });
    let events = diff(snap({ workflowRuns: [run({ done: false, conclusion: null })] }), running);
    expect(kinds(events)).toEqual(["check.completed", "check.completed"]);

    // `deploy` runs and fails, and GitHub finishes the run with its own conclusion.
    const deploying = snap({ checks: [...firstJobs, check("deploy", { done: false, conclusion: null })], workflowRuns: running.workflowRuns });
    expect(diff(running, deploying)).toEqual([]);
    const finished = snap({ checks: [...firstJobs, check("deploy", { conclusion: "failure" })], workflowRuns: [run({ conclusion: "failure" })] });
    events = diff(deploying, finished);
    expect(kinds(events)).toEqual(["check.completed", "check.failed", "workflow.completed"]);
    expect(events[2]).toMatchObject({
      id: "local:octo/widgets#7:workflow.completed:500:1:failure",
      at: "2026-10-27T00:03:00Z",
      data: { head_sha: HEAD1, run_id: 500, workflow: "CI", conclusion: "failure" },
      links: { html: "https://github.com/octo/widgets/actions/runs/500", api: "https://api.github.com/repos/octo/widgets/actions/runs/500" },
    });
    // Once.
    expect(diff(finished, { ...finished, fetchedAt: "2026-10-27T00:04:00Z" })).toEqual([]);

    // Jobs all done but GitHub not yet calling the run completed: still nothing.
    expect(kinds(diff(deploying, { ...finished, workflowRuns: deploying.workflowRuns }))).toEqual(["check.completed", "check.failed"]);

    // A re-run is the same run's next attempt, and is sent when it finishes,
    // even if both happened between two polls.
    const rerun = snap({ workflowRuns: [run({ attempt: 2, done: false, conclusion: null })] });
    expect(diff(finished, rerun)).toEqual([]);
    const rerunDone = snap({ workflowRuns: [run({ attempt: 2 })] });
    for (const before of [rerun, finished]) {
      events = diff(before, rerunDone);
      expect(kinds(events)).toEqual(["workflow.completed"]);
      expect(events[0]).toMatchObject({ id: "local:octo/widgets#7:workflow.completed:500:2:success", data: { conclusion: "success" } });
    }
  });

  it("workflow runs: a fork's run completed as action_required, then approved", () => {
    const waiting = snap({ workflowRuns: [run({ conclusion: "action_required" })] });
    let events = diff(snap({ workflowRuns: [] }), waiting);
    expect(events.map((e) => [e.id, e.data.conclusion])).toEqual([["local:octo/widgets#7:workflow.completed:500:1:action_required", "action_required"]]);

    // Approved: the same run, same attempt, runs and is completed again.
    const approved = snap({ workflowRuns: [run({ done: false, conclusion: null })] });
    expect(diff(waiting, approved)).toEqual([]);
    const done = snap({ workflowRuns: [run()] });
    for (const before of [approved, waiting]) {
      events = diff(before, done);
      expect(events.map((e) => [e.id, e.data.conclusion])).toEqual([["local:octo/widgets#7:workflow.completed:500:1:success", "success"]]);
    }
    expect(diff(done, { ...done })).toEqual([]);
  });

  it("workflow runs: other runs, pushes, and runs that can't be read", () => {
    const two = [run({ done: false, conclusion: null }), run({ id: 600, name: "Docs" })];
    // Another workflow's run finishing says nothing about this one.
    const events = diff(snap({ workflowRuns: [two[0], { ...two[1], done: false, conclusion: null }] }), snap({ workflowRuns: two }));
    expect(events.map((e) => [e.kind, e.data.run_id])).toEqual([["workflow.completed", 600]]);

    // After a push, every finished run on the new head counts, whatever the
    // old head's runs were, or if they couldn't be read.
    for (const workflowRuns of [[run()], null]) {
      expect(kinds(diff(snap({ workflowRuns }), snap({ head: HEAD2, workflowRuns: [run()] })))).toEqual(["pr.pushed", "workflow.completed"]);
    }

    // Without the last poll's runs (a token that couldn't read Actions,
    // or a snapshot saved before runs were read), a finished run can't be
    // told to have finished since, unless one of the last poll's checks
    // shows it was still running then.
    expect(diff(snap({ workflowRuns: null }), snap({ workflowRuns: [run()] }))).toEqual([]);
    expect(unknownRuns(snap({ workflowRuns: null }), snap({ workflowRuns: [run()] })).map((r) => r.id)).toEqual([500]);
    const { workflowRuns: _, ...old } = snap();
    expect(diff(old as never, snap({ workflowRuns: [run()] }))).toEqual([]);
    expect(diff(snap({ workflowRuns: [run({ done: false })] }), snap({ workflowRuns: null }))).toEqual([]);
    expect(unknownRuns(snap({ workflowRuns: [run({ done: false })] }), snap({ workflowRuns: null }))).toEqual([]);
  });

  it("workflow runs: runs carried as running, as the inbox file has them", () => {
    const next = snap({ workflowRuns: [run(), run({ id: 600 })] });
    const carried = (runningRuns: unknown) => ({ ...snap({ workflowRuns: null }), runningRuns } as unknown as Snapshot);
    expect(diff(carried([600]), next).map((e) => e.data.run_id)).toEqual([600]);
    // Not a list, or not numbers: none carried.
    for (const bad of ["600", { 600: true }, ["600"], null]) expect(diff(carried(bad), next)).toEqual([]);
    // A list with some numbers: just those carried.
    expect(diff(carried(["500", 600]), next).map((e) => e.data.run_id)).toEqual([600]);
  });

  it("workflow runs: a run whose check was still running at the last poll, its runs unread", () => {
    // Saved by a version that didn't read runs: run 500's lint job was
    // running, run 600's had finished.
    const { workflowRuns: _, ...old } = snap({
      checks: [check("lint", { done: false, conclusion: null }), check("docs", { workflowRunId: 600 })],
    });
    const next = snap({
      checks: [check("lint"), check("docs", { workflowRunId: 600 })],
      workflowRuns: [run(), run({ id: 600, name: "Docs" }), run({ id: 700, done: false, conclusion: null })],
    });
    const events = diff(old as never, next).filter((e) => e.kind === "workflow.completed");
    expect(events.map((e) => [e.data.run_id, e.data.conclusion])).toEqual([[500, "success"]]);
    // Whether 600 finished since can't be known; 700 hasn't finished.
    expect(unknownRuns(old as never, next).map((r) => r.id)).toEqual([600]);
    // The same while runs couldn't be read.
    expect(diff({ ...(old as Snapshot), workflowRuns: null }, next).filter((e) => e.kind === "workflow.completed")).toHaveLength(1);
    // With the last poll's runs, or after a push, there's nothing unknown.
    expect(unknownRuns(snap(), next)).toEqual([]);
    expect(unknownRuns(old as never, { ...next, head: HEAD2 })).toEqual([]);
  });

  it("commit statuses", () => {
    const prev = snap({ checks: [check("ci/x", { type: "status", key: "status:ci/x", checkRunId: null, workflowRunId: null, done: false, conclusion: null })] });
    const next = snap({ checks: [check("ci/x", { type: "status", key: "status:ci/x", checkRunId: null, workflowRunId: null, conclusion: "failure", url: "https://ci.example/1" })] });
    const events = diff(prev, next);
    expect(kinds(events)).toEqual(["check.completed", "check.failed"]);
    expect(events[0].data).toEqual({ head_sha: HEAD1, name: "ci/x", status_context: "ci/x", conclusion: "failure" });
    expect(events[0].links).toEqual({ html: "https://ci.example/1" });
  });

  it("a commit status set again to the same state is a new event", () => {
    const status = (o: Partial<Parameters<typeof check>[1]>) =>
      snap({ checks: [check("ci/x", { type: "status", key: "status:ci/x", checkRunId: null, workflowRunId: null, conclusion: "success", ...o })] });
    const first = diff(status({ done: false, conclusion: null }), status({ at: "2026-10-30T01:00:00Z" }));
    const again = diff(status({ done: false, conclusion: null }), status({ at: "2026-10-30T02:00:00Z" }));
    expect(kinds(again)).toEqual(["check.completed"]);
    expect(again[0].id).not.toBe(first[0].id);
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
