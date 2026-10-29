import type { WatchEvent } from "@watcheroni/protocol";

// `wait`'s text output, written so an agent can act on it without reading
// docs. Each line ends with the command that fetches the content, since
// events carry pointers, not text; its `--jq` keeps just the text an agent
// needs.

const BODY = "--jq .body";

// `reading` names a server inbox that is still being read although no PR
// is known to be watched (see Feed.ended).
export function formatText(events: WatchEvent[], stillWatching: string[], reading?: string): string {
  const groups = new Map<string, WatchEvent[]>();
  for (const e of events) {
    const key = e.repo ? (e.pr !== null ? `${e.repo.full_name}#${e.pr}` : e.repo.full_name) : "other";
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const lines: string[] = [];
  for (const [key, list] of groups) {
    lines.push(`${key}: ${list.length} new event${list.length === 1 ? "" : "s"}`);
    lines.push(...describeAll(list));
    lines.push("");
  }
  lines.push(footer(stillWatching, reading));
  return lines.join("\n");
}

export function footer(stillWatching: string[], reading?: string): string {
  if (!stillWatching.length && reading) return `Still reading inbox ${reading}. Run \`watcheroni wait\` again to keep watching.`;
  if (!stillWatching.length) return "Nothing is left to watch: every watched PR has been merged or closed.";
  const what = stillWatching.length === 1 ? `${stillWatching[0]} is still open` : `Still watching ${stillWatching.join(", ")}`;
  return `${what}. Run \`watcheroni wait\` again to keep watching.`;
}

function describeAll(events: WatchEvent[]): string[] {
  const lines: string[] = [];
  // A review's comments are listed under it, not one by one.
  const byReview = new Map<number, WatchEvent[]>();
  for (const e of events) {
    const reviewId = e.data.review_id;
    if (e.kind === "review_comment.created" && typeof reviewId === "number") {
      byReview.set(reviewId, [...(byReview.get(reviewId) ?? []), e]);
    }
  }
  const shownReviews = new Set<number>();
  for (const e of events) {
    const reviewId = typeof e.data.review_id === "number" ? e.data.review_id : null;
    if (e.kind === "review_comment.created" && reviewId !== null && (byReview.get(reviewId)?.length ?? 0) > 1) {
      if (shownReviews.has(reviewId)) continue;
      shownReviews.add(reviewId);
      const comments = byReview.get(reviewId)!;
      const where = comments.map((c) => location(c.data) || "?");
      lines.push(`- ${comments.length} review comments${by(e)} on ${where.join(", ")}`);
      // The review's own comments endpoint leaves out the lines.
      lines.push(`  gh api ${repoPath(e)}/pulls/${e.pr}/comments --paginate --jq '.[] | select(.pull_request_review_id == ${reviewId}) | "\\(.path):\\(.line // .original_line) \\(.body)"'`);
      continue;
    }
    const [text, command] = describe(e);
    lines.push(`- ${text}`);
    if (command) lines.push(`  ${command}`);
  }
  return lines;
}

function describe(e: WatchEvent): [string, string | null] {
  const d = e.data;
  const repo = repoPath(e);
  const short = (sha: unknown) => (typeof sha === "string" ? sha.slice(0, 7) : "?");
  switch (e.kind) {
    case "review.submitted":
      return [`review.submitted${by(e)}: ${d.state}`, `gh api ${repo}/pulls/${e.pr}/reviews/${d.review_id} --jq '.state, .body'`];
    case "review.dismissed":
      return [`review.dismissed: review ${d.review_id}`, null];
    case "review_comment.created": {
      const where = d.path ? ` on ${location(d)}` : "";
      const reply = d.in_reply_to ? " (a reply)" : "";
      return [`review_comment.created${by(e)}${where}${reply}`, `gh api ${repo}/pulls/comments/${d.comment_id} ${BODY}`];
    }
    case "comment.created":
      return [`comment.created${by(e)}`, `gh api ${repo}/issues/comments/${d.comment_id} ${BODY}`];
    case "thread.resolved":
    case "thread.unresolved": {
      // The command shows the thread's first comment.
      const where = d.path ? ` on ${location(d)}` : "";
      return [`${e.kind}${by(e)}${where}`, typeof d.comment_id === "number" ? `gh api ${repo}/pulls/comments/${d.comment_id} ${BODY}` : null];
    }
    case "check.failed": {
      const command = typeof d.workflow_run_id === "number"
        ? `gh run view ${d.workflow_run_id} -R ${e.repo?.full_name} --log-failed`
        : typeof d.check_run_id === "number" ? `gh api ${repo}/check-runs/${d.check_run_id}` : e.links.html ?? null;
      return [`check.failed: "${d.name}" (${d.conclusion}) on ${short(d.head_sha)}`, command];
    }
    case "checks.completed": {
      const failed = Array.isArray(d.failed) && d.failed.length ? `; failed: ${d.failed.join(", ")}` : "";
      return [`checks.completed on ${short(d.head_sha)}: ${d.result}${failed}`, failed ? `gh pr checks ${e.pr} -R ${e.repo?.full_name}` : null];
    }
    case "workflow.completed":
      return [`workflow.completed: "${d.workflow}" ${d.conclusion}`, d.conclusion === "success" ? null : `gh run view ${d.run_id} -R ${e.repo?.full_name} --log-failed`];
    case "merge.conflict":
      return [`merge.conflict with the base branch (head ${short(d.head_sha)}, base ${short(d.base_sha)})`, null];
    case "merge.clean":
      return ["merge.clean: the conflict is gone", null];
    case "pr.pushed":
      return [`pr.pushed: ${short(d.before)} -> ${short(d.after)}`, null];
    case "pr.base_changed":
      return [`pr.base_changed: ${d.from} -> ${d.to}`, null];
    case "pr.review_requested":
      return [`pr.review_requested: ${d.reviewer}`, null];
    case "pr.merged":
      return [`pr.merged as ${short(d.merge_sha)}`, null];
    case "watch.ended":
      return [`watch.ended: the PR was ${d.reason}`, null];
    case "watch.expired":
      return ["watch.expired: the server stopped watching after a week with nobody reading the inbox; watching it from this machine now", null];
    case "watch.unverified":
      return [d.reason === "access_denied"
        ? "watch.unverified: your GitHub login can no longer read this repo"
        : "watch.unverified: the server's access check lapsed; run `watcheroni login`, then name the PR again", null];
    case "watch.revoked":
      return ["watch.revoked: the watcheroni App lost access to this repo", null];
    case "inbox.gap":
      return [`inbox.gap: events after ${d.missed_after} were dropped before they were read; check the watched PRs on GitHub`, null];
    default:
      return [`${e.kind}${by(e)}`, e.links.api ? `gh api ${e.links.api.replace("https://api.github.com/", "")}` : null];
  }
}

// `a.ts:3`, or `a.ts` without a line, or "" without a path.
function location(d: WatchEvent["data"]): string {
  return d.path ? `${d.path}${d.line ? `:${d.line}` : ""}` : "";
}

function by(e: WatchEvent): string {
  return e.actor ? ` by ${e.actor.login}` : "";
}

function repoPath(e: WatchEvent): string {
  return `repos/${e.repo?.full_name ?? "?"}`;
}
