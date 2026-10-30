// Every kind the server sends, by where it comes from. normalise.ts and
// repo-hub.ts take their kinds' types from here, so a kind can't be sent
// without being listed, and a test checks docs/events.md against these
// lists (and the CLI's local ones, in packages/cli/src/diff.ts).

// From webhooks, by the normaliser.
export const WEBHOOK_KINDS = [
  "pr.opened",
  "pr.pushed",
  "pr.ready_for_review",
  "pr.converted_to_draft",
  "pr.review_requested",
  "pr.closed",
  "pr.merged",
  "pr.reopened",
  "pr.base_changed",
  "review.submitted",
  "review.dismissed",
  "review_comment.created",
  "thread.resolved",
  "thread.unresolved",
  "comment.created",
  "issue.opened",
  "issue.closed",
  "issue.reopened",
  "issue.labeled",
  "check.completed",
  "check.failed",
  "workflow.completed",
] as const;

// Made by RepoHub itself: the ends of subscriptions, and throttling.
export const HUB_KINDS = [
  "watch.ended",
  "watch.expired",
  "watch.unverified",
  "watch.revoked",
  "repo.throttled",
  "repo.unthrottled",
] as const;

// Produced by the normaliser for RepoHub's own use, never delivered:
// `pr.seen` carries a PR's head, base, author and state for repo-wide
// `base` and `author` filters.
export const INTERNAL_KINDS = ["pr.seen"] as const;

export type WebhookKind = (typeof WEBHOOK_KINDS)[number];
export type HubKind = (typeof HUB_KINDS)[number];
export type InternalKind = (typeof INTERNAL_KINDS)[number];
