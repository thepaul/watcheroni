import type { DataValue, UnsequencedEvent } from "@watcheroni/protocol";
import type { Actor, Check, Snapshot } from "./snapshot.ts";

// Turns the change between two snapshots of a PR into the same event kinds
// the server sends (PROTOCOL.md, "Kinds"), with IDs prefixed `local:`.
//
// What it remembers beyond the last snapshot, for the derived kinds.
export interface Memory {
  // The last checks.completed reported, so a re-run that changes the
  // result is reported again but an unchanged one isn't.
  rollup: { head: string; result: string } | null;
  conflict: boolean;
}

export function initialMemory(s: Snapshot): Memory {
  // The first snapshot is the starting point: what is already true when
  // watching starts isn't reported, as with a server subscription.
  const rollup = rollupOf(s);
  return { rollup: rollup ? { head: s.head, result: rollup.result } : null, conflict: s.mergeable === "CONFLICTING" };
}

const FAILED = new Set(["failure", "timed_out", "action_required", "startup_failure"]);

export function diff(prev: Snapshot, next: Snapshot, memory: Memory): { events: UnsequencedEvent[]; memory: Memory } {
  const events: UnsequencedEvent[] = [];
  const full = next.repo.full_name;
  const api = `https://api.github.com/repos/${full}`;
  const emit = (
    kind: string,
    discriminator: string,
    data: { [key: string]: DataValue },
    opts: { actor?: Actor | null; at?: string | null; html?: string | null; api?: string } = {},
  ) => {
    const links: { html?: string; api?: string } = {};
    if (opts.html) links.html = opts.html;
    if (opts.api) links.api = opts.api;
    events.push({
      v: 1,
      id: `local:${full}#${next.number}:${kind}:${discriminator}`,
      sub: null,
      kind,
      at: opts.at ?? next.fetchedAt,
      received_at: next.fetchedAt,
      repo: next.repo,
      pr: next.number,
      actor: opts.actor ?? null,
      data,
      links,
    });
  };
  const prLinks = { html: next.url, api: `${api}/pulls/${next.number}` };

  // The PR itself.
  if (next.head !== prev.head) emit("pr.pushed", next.head, { before: prev.head, after: next.head }, prLinks);
  if (next.base !== prev.base) emit("pr.base_changed", `${next.base}:${next.fetchedAt}`, { from: prev.base, to: next.base }, prLinks);
  if (prev.draft && !next.draft) emit("pr.ready_for_review", next.fetchedAt, {}, prLinks);
  if (!prev.draft && next.draft) emit("pr.converted_to_draft", next.fetchedAt, {}, prLinks);
  if (prev.state !== "OPEN" && next.state === "OPEN") emit("pr.reopened", next.fetchedAt, {}, prLinks);
  for (const reviewer of next.requested) {
    if (!prev.requested.includes(reviewer)) emit("pr.review_requested", `${reviewer}:${next.fetchedAt}`, { reviewer }, prLinks);
  }

  // Reviews, comments and threads.
  const prevReviews = new Map(prev.reviews.map((r) => [r.id, r]));
  for (const r of next.reviews) {
    const before = prevReviews.get(r.id);
    const links = { actor: r.author, at: r.at, html: r.url, api: `${api}/pulls/${next.number}/reviews/${r.id}` };
    if (!before && r.state !== "DISMISSED") {
      emit("review.submitted", String(r.id), { review_id: r.id, state: r.state.toLowerCase(), has_body: !r.empty }, links);
    } else if (before && before.state !== "DISMISSED" && r.state === "DISMISSED") {
      emit("review.dismissed", String(r.id), { review_id: r.id }, { ...links, actor: null, at: null });
    }
  }
  const prevComments = new Set(prev.reviewComments.map((c) => c.id));
  for (const c of next.reviewComments) {
    if (prevComments.has(c.id)) continue;
    emit("review_comment.created", String(c.id), {
      comment_id: c.id, review_id: c.reviewId, path: c.path, line: c.line, in_reply_to: c.inReplyTo,
    }, { actor: c.author, at: c.at, html: c.url, api: `${api}/pulls/comments/${c.id}` });
  }
  const prevThreads = new Map(prev.threads.map((t) => [t.id, t.resolved]));
  for (const t of next.threads) {
    const was = prevThreads.get(t.id);
    if (was === undefined || was === t.resolved) continue;
    const kind = t.resolved ? "thread.resolved" : "thread.unresolved";
    emit(kind, `${t.id}:${next.fetchedAt}`, {
      thread_node_id: t.id, path: t.path, line: t.line, comment_id: t.commentId,
    }, { html: next.url, api: t.commentId !== null ? `${api}/pulls/comments/${t.commentId}` : undefined });
  }
  const prevIssueComments = new Set(prev.comments.map((c) => c.id));
  for (const c of next.comments) {
    if (prevIssueComments.has(c.id)) continue;
    emit("comment.created", String(c.id), { comment_id: c.id }, { actor: c.author, at: c.at, html: c.url, api: `${api}/issues/comments/${c.id}` });
  }

  // Checks on the head commit. After a push, prev's checks belong to the
  // old head, so every check on the new head counts as new.
  const prevChecks = new Map(next.head === prev.head ? prev.checks.map((c) => [c.key, c]) : []);
  for (const c of next.checks) {
    const before = prevChecks.get(c.key);
    if (!isFailed(c) || (before && isFailed(before) && before.conclusion === c.conclusion)) continue;
    const data: { [key: string]: DataValue } = { head_sha: next.head, name: c.name, conclusion: c.conclusion };
    if (c.checkRunId !== null) data.check_run_id = c.checkRunId;
    else data.status_context = c.name;
    if (c.workflowRunId !== null) data.workflow_run_id = c.workflowRunId;
    emit("check.failed", `${next.head}:${c.key}:${c.conclusion}`, data, {
      at: c.at, html: c.url, api: c.checkRunId !== null ? `${api}/check-runs/${c.checkRunId}` : undefined,
    });
  }
  for (const [runId, run] of workflowRuns(next.checks)) {
    const before = workflowRuns([...prevChecks.values()]).get(runId);
    if (!run.done || before?.done) continue;
    emit("workflow.completed", String(runId), {
      head_sha: next.head, run_id: runId, workflow: run.workflow, conclusion: run.conclusion,
    }, { html: `https://github.com/${full}/actions/runs/${runId}`, api: `${api}/actions/runs/${runId}` });
  }
  let { rollup } = memory;
  const now = rollupOf(next);
  if (now && (rollup?.head !== next.head || rollup.result !== now.result)) {
    emit("checks.completed", `${next.head}:${now.result}`, { head_sha: next.head, ...now }, prLinks);
    rollup = { head: next.head, result: now.result };
  }

  // Mergeability. UNKNOWN means GitHub is still working it out.
  let { conflict } = memory;
  if (next.state === "OPEN" && next.mergeable === "CONFLICTING" && !conflict) {
    emit("merge.conflict", `${next.head}:${next.baseSha}`, { head_sha: next.head, base_sha: next.baseSha }, prLinks);
    conflict = true;
  } else if (next.mergeable === "MERGEABLE" && conflict) {
    emit("merge.clean", `${next.head}:${next.baseSha}`, { head_sha: next.head, base_sha: next.baseSha }, prLinks);
    conflict = false;
  }

  // Last, so an agent reads what happened before being told it's over.
  if (prev.state === "OPEN" && next.state === "MERGED") {
    emit("pr.merged", next.mergeSha ?? next.head, { merge_sha: next.mergeSha }, prLinks);
    emit("watch.ended", "merged", { reason: "merged" }, prLinks);
  } else if (prev.state === "OPEN" && next.state === "CLOSED") {
    emit("pr.closed", next.fetchedAt, {}, prLinks);
    emit("watch.ended", `closed:${next.fetchedAt}`, { reason: "closed" }, prLinks);
  }

  return { events, memory: { rollup, conflict } };
}

function isFailed(c: Check): boolean {
  return c.done && c.conclusion !== null && FAILED.has(c.conclusion);
}

// checks.completed's data, or null while any check is still running.
function rollupOf(s: Snapshot): { result: string; failed: string[]; counts: { [key: string]: number } } | null {
  if (!s.checks.length || s.checks.some((c) => !c.done)) return null;
  const counts = { success: 0, failure: 0, cancelled: 0, skipped: 0, neutral: 0 };
  const failed: string[] = [];
  for (const c of s.checks) {
    if (isFailed(c)) {
      counts.failure++;
      failed.push(c.name);
    } else if (c.conclusion === "cancelled") counts.cancelled++;
    else if (c.conclusion === "skipped" || c.conclusion === "stale") counts.skipped++;
    else if (c.conclusion === "neutral") counts.neutral++;
    else counts.success++;
  }
  const result = counts.failure ? "failure" : counts.cancelled ? "cancelled" : "success";
  return { result, failed: failed.slice(0, 20), counts };
}

function workflowRuns(checks: Check[]): Map<number, { workflow: string | null; done: boolean; conclusion: string }> {
  const runs = new Map<number, { workflow: string | null; done: boolean; conclusion: string }>();
  for (const c of checks) {
    if (c.workflowRunId === null) continue;
    const run = runs.get(c.workflowRunId) ?? { workflow: c.workflow, done: true, conclusion: "success" };
    run.done &&= c.done;
    if (isFailed(c)) run.conclusion = "failure";
    else if (c.conclusion === "cancelled" && run.conclusion === "success") run.conclusion = "cancelled";
    runs.set(c.workflowRunId, run);
  }
  return runs;
}
