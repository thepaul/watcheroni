import { graphql } from "./github.ts";
import type { Target } from "./targets.ts";

// What local mode knows about a PR at one moment: one GraphQL query (1
// point of GitHub's 5,000 an hour), reduced to IDs and states. diff.ts
// turns two of these into events.

export interface Actor { id: number; login: string; bot: boolean }

export interface Check {
  // Stable within a head commit: a check run's ID (a re-run gets a new
  // one) or a status context's name.
  key: string;
  name: string;
  type: "check_run" | "status";
  checkRunId: number | null;
  workflowRunId: number | null;
  workflow: string | null;
  done: boolean;
  // Lower case: success, failure, timed_out, cancelled, skipped, ...
  conclusion: string | null;
  url: string | null;
  at: string | null;
}

export interface Snapshot {
  fetchedAt: string;
  repo: { id: number; full_name: string };
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  draft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  head: string;
  base: string;
  baseSha: string;
  mergeSha: string | null;
  requested: string[];
  // Pending (unsubmitted) reviews and their comments are left out: only
  // their author can see them, and they appear once submitted.
  reviews: { id: number; state: string; at: string | null; url: string; author: Actor | null }[];
  reviewComments: {
    id: number;
    reviewId: number | null;
    inReplyTo: number | null;
    path: string | null;
    line: number | null;
    at: string;
    url: string;
    author: Actor | null;
  }[];
  threads: { id: string; resolved: boolean }[];
  comments: { id: number; at: string; url: string; author: Actor | null }[];
  // Checks on the head commit only.
  checks: Check[];
}

const QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    databaseId
    nameWithOwner
    pullRequest(number: $number) {
      number url state isDraft mergeable
      headRefOid baseRefName baseRefOid
      mergeCommit { oid }
      reviewRequests(first: 50) { nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Team { slug } } } }
      reviews(last: 100) { nodes { databaseId state submittedAt url author { ...actor } } }
      reviewThreads(last: 100) { nodes { id isResolved comments(last: 100) { nodes {
        databaseId path line createdAt url replyTo { databaseId } pullRequestReview { databaseId state } author { ...actor }
      } } } }
      comments(last: 100) { nodes { databaseId createdAt url author { ...actor } } }
      commits(last: 1) { nodes { commit { oid statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { databaseId name status conclusion detailsUrl completedAt checkSuite { workflowRun { databaseId workflow { name } } } }
        ... on StatusContext { context state targetUrl createdAt }
      } } } } } }
    }
  }
}
fragment actor on Actor { __typename login ... on User { databaseId } ... on Bot { databaseId } }
`;

interface RawActor { __typename: string; login: string; databaseId?: number }
interface RawContext {
  __typename: "CheckRun" | "StatusContext";
  databaseId?: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string | null;
  completedAt?: string | null;
  checkSuite?: { workflowRun: { databaseId: number; workflow: { name: string } } | null };
  context?: string;
  state?: string;
  targetUrl?: string | null;
  createdAt?: string;
}
interface RawPr {
  number: number;
  url: string;
  state: Snapshot["state"];
  isDraft: boolean;
  mergeable: Snapshot["mergeable"];
  headRefOid: string;
  baseRefName: string;
  baseRefOid: string;
  mergeCommit: { oid: string } | null;
  reviewRequests: { nodes: { requestedReviewer: { __typename: string; login?: string; slug?: string } | null }[] };
  reviews: { nodes: { databaseId: number; state: string; submittedAt: string | null; url: string; author: RawActor | null }[] };
  reviewThreads: { nodes: { id: string; isResolved: boolean; comments: { nodes: {
    databaseId: number;
    path: string | null;
    line: number | null;
    createdAt: string;
    url: string;
    replyTo: { databaseId: number } | null;
    pullRequestReview: { databaseId: number; state: string } | null;
    author: RawActor | null;
  }[] } }[] };
  comments: { nodes: { databaseId: number; createdAt: string; url: string; author: RawActor | null }[] };
  commits: { nodes: { commit: { oid: string; statusCheckRollup: { contexts: { nodes: RawContext[] } } | null } }[] };
}
interface Raw {
  repository: { databaseId: number; nameWithOwner: string; pullRequest: RawPr | null } | null;
}

export async function fetchSnapshot(target: Target): Promise<Snapshot> {
  const data = await graphql<Raw>(QUERY, { owner: target.owner, name: target.name, number: target.number });
  const repo = data.repository;
  if (!repo?.pullRequest) throw new Error(`${target.owner}/${target.name}#${target.number}: no such pull request`);
  return toSnapshot(repo.databaseId, repo.nameWithOwner, repo.pullRequest, new Date().toISOString());
}

export function toSnapshot(repoId: number, fullName: string, pr: RawPr, fetchedAt: string): Snapshot {
  const commit = pr.commits.nodes[0]?.commit;
  const contexts = commit?.oid === pr.headRefOid ? commit.statusCheckRollup?.contexts.nodes ?? [] : [];
  return {
    fetchedAt,
    repo: { id: repoId, full_name: fullName },
    number: pr.number,
    url: pr.url,
    state: pr.state,
    draft: pr.isDraft,
    mergeable: pr.mergeable,
    head: pr.headRefOid,
    base: pr.baseRefName,
    baseSha: pr.baseRefOid,
    mergeSha: pr.mergeCommit?.oid ?? null,
    requested: pr.reviewRequests.nodes.flatMap(({ requestedReviewer: r }) =>
      !r ? [] : r.__typename === "Team" ? [`team:${r.slug}`] : r.login ? [r.login] : []),
    reviews: pr.reviews.nodes
      .filter((r) => r.state !== "PENDING")
      .map((r) => ({ id: r.databaseId, state: r.state, at: r.submittedAt, url: r.url, author: actor(r.author) })),
    reviewComments: pr.reviewThreads.nodes.flatMap((t) => t.comments.nodes)
      .filter((c) => c.pullRequestReview?.state !== "PENDING")
      .map((c) => ({
        id: c.databaseId,
        reviewId: c.pullRequestReview?.databaseId ?? null,
        inReplyTo: c.replyTo?.databaseId ?? null,
        path: c.path,
        line: c.line,
        at: c.createdAt,
        url: c.url,
        author: actor(c.author),
      })),
    threads: pr.reviewThreads.nodes.map((t) => ({ id: t.id, resolved: t.isResolved })),
    comments: pr.comments.nodes.map((c) => ({ id: c.databaseId, at: c.createdAt, url: c.url, author: actor(c.author) })),
    checks: contexts.map(toCheck),
  };
}

function actor(a: RawActor | null): Actor | null {
  return a ? { id: a.databaseId ?? 0, login: a.login, bot: a.__typename === "Bot" } : null;
}

function toCheck(c: RawContext): Check {
  if (c.__typename === "CheckRun") {
    return {
      key: `check_run:${c.databaseId}`,
      name: c.name ?? "",
      type: "check_run",
      checkRunId: c.databaseId ?? null,
      workflowRunId: c.checkSuite?.workflowRun?.databaseId ?? null,
      workflow: c.checkSuite?.workflowRun?.workflow.name ?? null,
      done: c.status === "COMPLETED",
      conclusion: c.conclusion?.toLowerCase() ?? null,
      url: c.detailsUrl ?? null,
      at: c.completedAt ?? null,
    };
  }
  // Commit statuses: success, failure, error, pending, expected.
  const state = c.state?.toLowerCase() ?? "pending";
  const done = state !== "pending" && state !== "expected";
  return {
    key: `status:${c.context}`,
    name: c.context ?? "",
    type: "status",
    checkRunId: null,
    workflowRunId: null,
    workflow: null,
    done,
    conclusion: done ? (state === "success" ? "success" : "failure") : null,
    url: c.targetUrl ?? null,
    at: c.createdAt ?? null,
  };
}
