import type { InternalKind, WebhookKind } from "../kinds";
import type { DataValue, UnsequencedEvent } from "../protocol";

// Turns one GitHub webhook into protocol events: IDs, SHAs, states and the
// actor. No text (titles, bodies, comments, check output) survives this
// step. `sub` is filled in later, when an event is matched to a
// subscription.
//
// The kinds it can emit are listed in ../kinds.ts. Besides protocol kinds
// this emits one internal kind that RepoHub uses and never delivers, last
// so the other events' IDs don't move: `pr.seen`, from any payload that
// describes the PR (its head, base, author and state), for
// repository-wide subscriptions' `base` and `author` filters.

// Only the fields read below. Everything is optional because GitHub's
// payloads vary by event, action and age.
interface User { id: number; login: string; type?: string }
interface Repository { id: number; full_name: string; html_url?: string; url?: string }
interface PullRequest {
  number: number;
  state?: string;
  user?: User;
  html_url?: string;
  url?: string;
  draft?: boolean;
  merged?: boolean;
  merge_commit_sha?: string | null;
  updated_at?: string;
  head?: { sha: string; ref?: string };
  base?: { ref: string; sha?: string };
}
interface Payload {
  action?: string;
  sender?: User;
  repository?: Repository;
  pull_request?: PullRequest;
  number?: number;
  before?: string;
  after?: string;
  requested_reviewer?: User;
  requested_team?: { slug: string };
  changes?: { base?: { ref?: { from: string } } };
  review?: { id: number; state: string; body?: string | null; html_url?: string; submitted_at?: string };
  comment?: {
    id: number;
    html_url?: string;
    url?: string;
    created_at?: string;
    pull_request_review_id?: number | null;
    path?: string;
    line?: number | null;
    original_line?: number | null;
    in_reply_to_id?: number;
  };
  thread?: {
    node_id: string;
    comments?: { id: number; url?: string; path?: string; line?: number | null; original_line?: number | null }[];
  };
  issue?: { number: number; html_url?: string; url?: string; updated_at?: string; pull_request?: object; state?: string; user?: User };
  label?: { name: string };
  check_run?: {
    id: number;
    name: string;
    head_sha: string;
    status: string;
    conclusion: string | null;
    html_url?: string;
    url?: string;
    completed_at?: string | null;
    pull_requests?: { number: number }[];
  };
  // `status` events.
  sha?: string;
  state?: string;
  context?: string;
  target_url?: string | null;
  updated_at?: string;
  workflow_run?: {
    id: number;
    name: string;
    head_sha: string;
    conclusion: string | null;
    html_url?: string;
    url?: string;
    updated_at?: string;
    pull_requests?: { number: number }[];
  };
}

const FAILED = new Set(["failure", "timed_out", "action_required", "startup_failure"]);

export function normalise(
  eventName: string,
  deliveryId: string,
  payload: Payload,
  receivedAt: string,
): UnsequencedEvent[] {
  const repo = payload.repository ? { id: payload.repository.id, full_name: payload.repository.full_name } : null;
  if (!repo) return [];
  const actor = payload.sender
    ? { id: payload.sender.id, login: payload.sender.login, bot: payload.sender.type === "Bot" }
    : null;
  const out: UnsequencedEvent[] = [];
  const emit = (
    kind: WebhookKind | InternalKind,
    pr: number | null,
    data: { [key: string]: DataValue },
    at: string | null | undefined,
    links: { html?: string; api?: string } = {},
  ) => {
    out.push({
      v: 1,
      id: `${deliveryId}.${out.length}`,
      sub: null,
      kind,
      at: at ?? receivedAt,
      received_at: receivedAt,
      repo,
      pr,
      actor,
      data,
      links,
    });
  };

  const { action } = payload;
  switch (eventName) {
    case "pull_request": {
      const pr = payload.pull_request;
      if (!pr) break;
      const links = { html: pr.html_url, api: pr.url };
      const at = pr.updated_at;
      switch (action) {
        case "opened":
          emit("pr.opened", pr.number, { head_sha: pr.head?.sha ?? null, base: pr.base?.ref ?? null, draft: !!pr.draft }, at, links);
          break;
        case "synchronize":
          // The payload doesn't say whether it was a force-push, and
          // nothing works it out.
          emit("pr.pushed", pr.number, { before: payload.before ?? null, after: payload.after ?? null }, at, links);
          break;
        case "ready_for_review":
        case "converted_to_draft":
        case "reopened":
          emit(`pr.${action}`, pr.number, {}, at, links);
          break;
        case "review_requested": {
          const reviewer = payload.requested_reviewer?.login
            ?? (payload.requested_team ? `team:${payload.requested_team.slug}` : null);
          emit("pr.review_requested", pr.number, { reviewer }, at, links);
          break;
        }
        case "closed":
          if (pr.merged) emit("pr.merged", pr.number, { merge_sha: pr.merge_commit_sha ?? null }, at, links);
          else emit("pr.closed", pr.number, {}, at, links);
          break;
        case "edited": {
          const from = payload.changes?.base?.ref?.from;
          if (from) emit("pr.base_changed", pr.number, { from, to: pr.base?.ref ?? null }, at, links);
          break;
        }
      }
      break;
    }

    case "pull_request_review": {
      const { review, pull_request: pr } = payload;
      if (!review || !pr) break;
      const links = { html: review.html_url, api: `${pr.url}/reviews/${review.id}` };
      if (action === "submitted") {
        emit("review.submitted", pr.number, {
          review_id: review.id, state: review.state.toLowerCase(), has_body: !!review.body?.trim(),
        }, review.submitted_at, links);
      } else if (action === "dismissed") {
        emit("review.dismissed", pr.number, { review_id: review.id }, null, links);
      }
      break;
    }

    case "pull_request_review_comment": {
      const { comment, pull_request: pr } = payload;
      if (action !== "created" || !comment || !pr) break;
      emit("review_comment.created", pr.number, {
        comment_id: comment.id,
        review_id: comment.pull_request_review_id ?? null,
        path: comment.path ?? null,
        line: comment.line ?? comment.original_line ?? null,
        in_reply_to: comment.in_reply_to_id ?? null,
      }, comment.created_at, { html: comment.html_url, api: comment.url });
      break;
    }

    case "pull_request_review_thread": {
      const { thread, pull_request: pr } = payload;
      if (!thread || !pr || (action !== "resolved" && action !== "unresolved")) break;
      const first = thread.comments?.[0];
      emit(`thread.${action}`, pr.number, {
        thread_node_id: thread.node_id,
        path: first?.path ?? null,
        line: first?.line ?? first?.original_line ?? null,
        comment_id: first?.id ?? null,
      }, null, { html: pr.html_url, api: first?.url });
      break;
    }

    case "issue_comment": {
      const { comment, issue } = payload;
      if (action !== "created" || !comment || !issue) break;
      const isPr = !!issue.pull_request;
      emit("comment.created", isPr ? issue.number : null,
        isPr ? { comment_id: comment.id } : { comment_id: comment.id, issue: issue.number },
        comment.created_at, { html: comment.html_url, api: comment.url });
      break;
    }

    case "issues": {
      const { issue } = payload;
      if (!issue || issue.pull_request) break;
      const links = { html: issue.html_url, api: issue.url };
      if (action === "opened" || action === "closed" || action === "reopened") {
        emit(`issue.${action}`, null, { issue: issue.number }, issue.updated_at, links);
      } else if (action === "labeled" && payload.label) {
        emit("issue.labeled", null, { issue: issue.number, label: payload.label.name }, issue.updated_at, links);
      }
      break;
    }

    case "check_run": {
      const run = payload.check_run;
      if (!run) break;
      // Apps can create a run that has already finished; that counts as
      // its completion. (GitHub may then send `completed` as well; RepoHub
      // passes the same completion on once.)
      const finished = action === "completed" || (action === "created" && run.status === "completed");
      if (!finished) break;
      const links = { html: run.html_url, api: run.url };
      // A check run can belong to several PRs (or none, if it ran on a
      // branch without one; RepoHub then matches on head_sha).
      const prs = run.pull_requests?.length ? run.pull_requests.map((p) => p.number) : [null];
      for (const pr of prs) {
        const data = { head_sha: run.head_sha, name: run.name, check_run_id: run.id, conclusion: run.conclusion };
        emit("check.completed", pr, data, run.completed_at, links);
        if (run.conclusion && FAILED.has(run.conclusion)) emit("check.failed", pr, data, run.completed_at, links);
      }
      break;
    }

    case "status": {
      // Commit statuses carry no PR; RepoHub matches on head_sha.
      if (!payload.sha || !payload.context || !payload.state || payload.state === "pending") break;
      const conclusion = payload.state === "success" ? "success" : "failure";
      const data = { head_sha: payload.sha, name: payload.context, status_context: payload.context, conclusion };
      const links = payload.target_url ? { html: payload.target_url } : {};
      emit("check.completed", null, data, payload.updated_at, links);
      if (conclusion === "failure") emit("check.failed", null, data, payload.updated_at, links);
      break;
    }

    case "workflow_run": {
      const run = payload.workflow_run;
      if (action !== "completed" || !run) break;
      const prs = run.pull_requests?.length ? run.pull_requests.map((p) => p.number) : [null];
      for (const pr of prs) {
        emit("workflow.completed", pr, {
          head_sha: run.head_sha, run_id: run.id, workflow: run.name, conclusion: run.conclusion,
        }, run.updated_at, { html: run.html_url, api: run.url });
      }
      break;
    }
  }

  // Only alongside other events, so a delivery that's otherwise ignored
  // still never reaches RepoHub.
  if (out.length) {
    const pr = payload.pull_request;
    const issue = payload.issue;
    if (pr && typeof pr.number === "number") {
      emit("pr.seen", pr.number, {
        head_sha: pr.head?.sha ?? null,
        base: pr.base?.ref ?? null,
        author: pr.user?.login ?? null,
        state: pr.state ?? null,
      }, null);
    } else if (eventName === "issue_comment" && issue?.pull_request) {
      emit("pr.seen", issue.number, { author: issue.user?.login ?? null, state: issue.state ?? null }, null);
    }
  }
  return out;
}
