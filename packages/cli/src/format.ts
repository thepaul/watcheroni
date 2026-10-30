import type { WatchEvent } from "@watcheroni/protocol";

// `wait`'s text output, written so an agent can act on it without reading
// docs. Each line ends with the command that fetches the content, since
// events carry pointers, not text; its `--jq` keeps just the text an agent
// needs.
//
// Names, paths, branches, labels and links come from whoever made them on
// GitHub (a fork's workflow names its checks), and an agent reads this
// output and runs its commands. So every such value is cleaned and quoted
// unless it is plainly one word, and commands are built only from numeric
// IDs and a repository name of the shape GitHub allows.

const BODY = "--jq .body";

// `reading` names a server inbox that is still being read although no PR
// is known to be watched (see Feed.ended).
// `repoEnded`: the server ended a whole-repository watch.
export function formatText(events: WatchEvent[], stillWatching: string[], reading?: string, repoEnded = false): string {
  const groups = new Map<string, WatchEvent[]>();
  for (const e of events) {
    const repo = e.repo ? word(e.repo.full_name) : "other";
    const key = e.repo && e.pr !== null ? `${repo}#${e.pr}` : repo;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const lines: string[] = [];
  for (const [key, list] of groups) {
    lines.push(`${key}: ${list.length} new event${list.length === 1 ? "" : "s"}`);
    lines.push(...describeAll(list));
    lines.push("");
  }
  lines.push(footer(stillWatching, reading, repoEnded));
  return lines.join("\n");
}

export function footer(stillWatching: string[], reading?: string, repoEnded = false): string {
  if (!stillWatching.length && reading) return `Still reading inbox ${reading}. Run \`watcheroni wait\` again to keep watching.`;
  if (!stillWatching.length && repoEnded) return "Nothing is left to watch: the server's watch on the repository has ended.";
  if (!stillWatching.length) return "Nothing is left to watch: every watched PR has been merged or closed.";
  // A single PR "is still open"; a whole repository is just watched.
  const what = stillWatching.length === 1 && stillWatching[0].includes("#") ? `${stillWatching[0]} is still open` : `Still watching ${stillWatching.join(", ")}`;
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
      const repo = repoPath(e);
      if (repo && id(e.pr) && id(reviewId)) {
        lines.push(`  gh api ${repo}/pulls/${e.pr}/comments --paginate --jq '.[] | select(.pull_request_review_id == ${reviewId}) | "\\(.path)\\(.line // .original_line | if . then ":\\(.)" else "" end) \\(.body)"'`);
      }
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
  const full = repo ? repo.slice("repos/".length) : null;
  const api = repo ? `gh api ${repo}` : null;
  // A command only when the repository and every ID in it are sound.
  const cmd = (...parts: (string | number | null)[]) => (parts.every((p) => p !== null) ? parts.join("") : null);
  const pr = id(e.pr);
  const short = (sha: unknown) => (typeof sha === "string" && /^[0-9a-f]{7,64}$/i.test(sha) ? sha.slice(0, 7) : "?");
  switch (e.kind) {
    case "review.submitted":
      return [`review.submitted${by(e)}: ${word(d.state)}`, cmd(api, "/pulls/", pr, "/reviews/", id(d.review_id), " --jq '.state, .body'")];
    case "review.dismissed":
      return [`review.dismissed: review ${id(d.review_id) ?? "?"}`, null];
    case "review_comment.created": {
      const where = d.path ? ` on ${location(d)}` : "";
      const reply = d.in_reply_to ? " (a reply)" : "";
      return [`review_comment.created${by(e)}${where}${reply}`, cmd(api, "/pulls/comments/", id(d.comment_id), ` ${BODY}`)];
    }
    case "comment.created":
      return [`comment.created${by(e)}`, cmd(api, "/issues/comments/", id(d.comment_id), ` ${BODY}`)];
    case "thread.resolved":
    case "thread.unresolved": {
      // The command shows the thread's first comment.
      const where = d.path ? ` on ${location(d)}` : "";
      return [`${e.kind}${by(e)}${where}`, cmd(api, "/pulls/comments/", id(d.comment_id), ` ${BODY}`)];
    }
    case "check.failed": {
      // A commit status has no ID to fetch; its link is shown as a link,
      // never as a command.
      const command = id(d.workflow_run_id)
        ? cmd("gh run view ", id(d.workflow_run_id), " -R ", full, " --log-failed")
        : cmd(api, "/check-runs/", id(d.check_run_id));
      const details = command ? null : link(e.links.html);
      return [`check.failed: ${quoted(d.name)} (${word(d.conclusion)}) on ${short(d.head_sha)}${details ? `; details: ${details}` : ""}`, command];
    }
    case "checks.completed": {
      const failed = Array.isArray(d.failed) && d.failed.length ? `; failed: ${d.failed.slice(0, MAX_LISTED).map(quoted).join(", ")}${d.failed.length > MAX_LISTED ? `, and ${d.failed.length - MAX_LISTED} more` : ""}` : "";
      return [`checks.completed on ${short(d.head_sha)}: ${word(d.result)}${failed}`, failed ? cmd("gh pr checks ", pr, " -R ", full) : null];
    }
    case "workflow.completed":
      return [`workflow.completed: ${quoted(d.workflow)} ${word(d.conclusion)}`, d.conclusion === "success" ? null : cmd("gh run view ", id(d.run_id), " -R ", full, " --log-failed")];
    case "merge.conflict":
      return [`merge.conflict with the base branch (head ${short(d.head_sha)}, base ${short(d.base_sha)})`, null];
    case "merge.clean":
      return ["merge.clean: the conflict is gone", null];
    case "pr.pushed":
      return [`pr.pushed: ${short(d.before)} -> ${short(d.after)}`, null];
    case "pr.base_changed":
      return [`pr.base_changed: ${word(d.from)} -> ${word(d.to)}`, null];
    case "pr.review_requested":
      return [`pr.review_requested: ${word(d.reviewer)}`, null];
    case "pr.merged":
      return [`pr.merged as ${short(d.merge_sha)}`, null];
    case "watch.ended":
      return [`watch.ended: the PR was ${word(d.reason)}`, null];
    // A repository-wide watch (no PR) isn't polled from here when it ends.
    case "watch.expired":
      return [e.pr === null
        ? "watch.expired: the server stopped watching after a week with nobody reading the inbox; name the repository again to keep watching"
        : "watch.expired: the server stopped watching after a week with nobody reading the inbox; watching it from this machine now", null];
    case "watch.unverified":
      return [d.reason === "access_denied"
        ? "watch.unverified: your GitHub login can no longer read this repo"
        : `watch.unverified: the server's access check lapsed; run \`watcheroni login\`, then name the ${e.pr === null ? "repository" : "PR"} again`, null];
    case "watch.revoked":
      return ["watch.revoked: the watcheroni App lost access to this repo", null];
    case "inbox.gap":
      return [`inbox.gap: events after ${id(d.missed_after) ?? "?"} were dropped before they were read; check the watched PRs on GitHub`, null];
    default: {
      const path = typeof e.links.api === "string" ? /^https:\/\/api\.github\.com\/([\w.\/-]+)$/.exec(e.links.api)?.[1] : undefined;
      return [`${word(e.kind)}${by(e)}`, path && !path.includes("..") ? `gh api ${path}` : null];
    }
  }
}

// `a.ts:3`, or `a.ts` without a line, or "" without a path.
function location(d: WatchEvent["data"]): string {
  return d.path ? `${word(d.path)}${id(d.line) ? `:${d.line}` : ""}` : "";
}

function by(e: WatchEvent): string {
  return e.actor ? ` by ${word(e.actor.login)}` : "";
}

// `repos/owner/name`, or null if the name isn't one GitHub would give.
function repoPath(e: WatchEvent): string | null {
  const name = e.repo?.full_name;
  return typeof name === "string" && REPO_NAME.test(name) ? `repos/${name}` : null;
}

const REPO_NAME = /^[A-Za-z0-9-]{1,39}\/[\w.-]{1,100}$/;
const PLAIN = /^[\w.\/@+:-]+$/;
const MAX_LENGTH = 100;
const MAX_LISTED = 10;
// C0 and C1 controls, line and paragraph separators, zero-width and
// bidirectional formatting characters.
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]+/g;

// A value made printable on one line, and cut to a sane length.
export function clean(v: unknown): string {
  const s = String(v ?? "").replace(UNPRINTABLE, " ").replace(/\s+/g, " ").trim();
  return s.length > MAX_LENGTH ? `${s.slice(0, MAX_LENGTH - 1)}…` : s;
}

// A value that should be one word (a login, path, branch, state): bare
// when it is, quoted when it isn't, so it can't pass for more output.
function word(v: unknown): string {
  const s = clean(v);
  return s && PLAIN.test(s) ? s : JSON.stringify(s);
}

// A free-form name (a check, a workflow), always quoted.
function quoted(v: unknown): string {
  return JSON.stringify(clean(v));
}

// A positive integer as text, or null.
function id(v: unknown): string | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? String(v) : null;
}

// An http(s) URL, percent-encoded so it is one unbroken word, or null.
function link(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const url = new URL(v);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const href = url.href.replace(/[^\x21-\x7e]|["'`<>\\]/g, encodeURIComponent);
    return href.length > 500 ? null : href;
  } catch {
    return null;
  }
}
