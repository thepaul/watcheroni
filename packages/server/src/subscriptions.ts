// POST / GET / DELETE /v1/inboxes/{name}/subscriptions[/{id}]
// (PROTOCOL.md, "Subscriptions"). The Worker does the GitHub checks, then
// RepoHub takes the routing copy and Account the index.

import type { Account } from "./account";
import { findInstallation, githubHeaders } from "./app";
import { GITHUB_API_URL, GITHUB_WEB_URL, checkUserToken } from "./github";
import type { Installation } from "./installation";
import {
  MAX_TTL_SECONDS,
  PRIVATE_VERIFY_SECONDS,
  json,
  problem,
  readJson,
  withRetryAfter,
  type SubscriptionInfo,
  type SubscriptionRequest,
  type SubscriptionsResponse,
} from "./protocol";
import type { OpenPr, PrBaseline, RepoHub, RepoInfo } from "./repo-hub";

// The App's public page, where a repo owner installs it. The slug is the
// GITHUB_APP_SLUG var, since a self-hosted copy has its own App; undefined
// if it isn't set.
export function installUrl(env: Pick<Env, "GITHUB_APP_SLUG">): string | undefined {
  return env.GITHUB_APP_SLUG ? `${GITHUB_WEB_URL}/apps/${env.GITHUB_APP_SLUG}/installations/new` : undefined;
}

const REPO_NAME = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/;
const KIND_PATTERN = /^(\*|[a-z_]+(\.[a-z_]+)*(\.\*)?)$/;
const MAX_KINDS = 50;
const MAX_ACTORS = 100;
// A branch name as git allows it, roughly, and a GitHub login (or a bot's).
const BRANCH_NAME = /^[^\s~^:?*[\\\x00-\x1f\x7f]{1,255}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

type AccountStub = DurableObjectStub<Account>;

export function repoHubStub(env: Env, repoId: number): DurableObjectStub<RepoHub> {
  return env.REPO_HUB.get(env.REPO_HUB.idFromName(`repo:${repoId}`));
}

export function installationStub(env: Env, installationId: number): DurableObjectStub<Installation> {
  return env.INSTALLATION.get(env.INSTALLATION.idFromName(`inst:${installationId}`));
}

const unavailable = (title: string) => withRetryAfter(problem(503, "unavailable", title), 30);

export async function createSubscription(
  request: Request,
  env: Env,
  account: AccountStub,
  accountId: number,
  inbox: string,
): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request);
  const parsed = parseRequest(body);
  if (typeof parsed === "string") return problem(400, "invalid_request", parsed);
  const [, owner, name] = REPO_NAME.exec(parsed.repo)!;

  // 1. The App is installed on the repo.
  const found = await findInstallation(env, owner, name);
  if (!found.ok) {
    return found.reason === "not_installed"
      ? notInstalled(env, parsed.repo)
      : unavailable("Couldn't ask GitHub about the repository");
  }
  const installation = installationStub(env, found.id);
  // Spending a call each for the repo and the PR, made with the token.
  const minted = await installation.token(found.id, parsed.pr === undefined ? 1 : 2);
  if (!minted.ok) {
    if (minted.reason === "not_installed") return notInstalled(env, parsed.repo);
    if (minted.reason === "rate_limited") {
      return withRetryAfter(problem(429, "rate_limited", "This repository's installation has used its GitHub API budget"), minted.retry_after);
    }
    return unavailable("Couldn't get an installation token from GitHub");
  }

  const repoRes = await githubGet(minted.token, `/repos/${owner}/${name}`);
  if (!repoRes) return unavailable("Couldn't reach GitHub");
  if (repoRes.status === 404) return notInstalled(env, parsed.repo);
  if (!repoRes.ok) return unavailable(`GitHub answered ${repoRes.status} for the repository`);
  const repoBody = (await repoRes.json()) as { id: number; full_name: string; private: boolean };
  const repo: RepoInfo & { private: boolean } = { id: repoBody.id, full_name: repoBody.full_name, private: !!repoBody.private };

  // 2. A private repo needs the user's own token, used once and forgotten.
  let verifiedUntil: number | null = null;
  if (repo.private) {
    const denied = await checkPrivateAccess(request, env, accountId, repo.full_name);
    if (denied) return denied;
    verifiedUntil = Date.now() + PRIVATE_VERIFY_SECONDS * 1000;
  }

  // The PR's current state: it must be open, and its head lets RepoHub
  // match statuses (which name only a commit) to it from the start.
  let baseline: PrBaseline | undefined;
  if (parsed.pr !== undefined) {
    const prRes = await githubGet(minted.token, `/repos/${repo.full_name}/pulls/${parsed.pr}`);
    if (!prRes) return unavailable("Couldn't reach GitHub");
    if (prRes.status === 404) return problem(404, "not_found", `No pull request #${parsed.pr} in ${repo.full_name}`);
    if (!prRes.ok) return unavailable(`GitHub answered ${prRes.status} for the pull request`);
    baseline = toBaseline((await prRes.json()) as PullBody);
  }

  // 3. Quotas: the account's here, the repo's in RepoHub.
  const room = await account.checkSubscription(inbox);
  if (!room.ok) return problem(room.status, room.code, room.detail);

  const result = await repoHubStub(env, repo.id).subscribe(
    {
      account: accountId,
      inbox,
      pr: parsed.pr ?? null,
      kinds: parsed.kinds,
      base: parsed.base,
      author: parsed.author,
      ignore: parsed.ignore,
      ttl_seconds: parsed.ttl_seconds,
      verified_until: verifiedUntil,
    },
    repo,
    baseline,
  );
  if (!result.ok) {
    const res = problem(result.status, result.code, result.detail);
    return result.retry_after ? withRetryAfter(res, result.retry_after) : res;
  }
  const sub = result.subscription;
  const info: SubscriptionInfo = {
    id: sub.id,
    inbox,
    repo,
    pr: sub.pr,
    kinds: sub.kinds,
    ...(sub.base === undefined ? {} : { base: sub.base }),
    ...(sub.author === undefined ? {} : { author: sub.author }),
    ignore: sub.ignore,
    created_at: new Date(sub.created_at).toISOString(),
    expires_at: new Date(sub.expires_at).toISOString(),
    verified_until: sub.verified_until === null ? null : new Date(sub.verified_until).toISOString(),
    state: "active",
  };
  await account.saveSubscription(info);
  await installation.addRepo(repo.id);
  if (result.needs_open_prs) await rememberOpenPrs(env, installation, found.id, repo.full_name, repo.id);
  if (baseline) {
    info.baseline = { state: baseline.state, head_sha: baseline.head_sha };
  }
  return json(info, result.created ? 201 : 200);
}

export async function listSubscriptions(account: AccountStub, inbox: string): Promise<Response> {
  const subscriptions = await account.listSubscriptions(inbox);
  if (!subscriptions) return problem(404, "not_found", "No such inbox");
  return json({ subscriptions } satisfies SubscriptionsResponse);
}

export async function getSubscription(account: AccountStub, inbox: string, id: string): Promise<Response> {
  const sub = await account.getSubscription(inbox, id);
  return sub ? json(sub) : problem(404, "not_found", "No such subscription");
}

// POST /v1/inboxes/{name}/subscriptions/{id}/verify: a private repo's
// subscription shows a fresh GitHub token before `verified_until`. If the
// token works but can't read the repo any more, the user has lost access,
// and the subscription ends at once with `watch.unverified`.
export async function verifySubscription(
  request: Request,
  env: Env,
  account: AccountStub,
  accountId: number,
  inbox: string,
  id: string,
): Promise<Response> {
  const sub = await account.getSubscription(inbox, id);
  if (!sub) return problem(404, "not_found", "No such subscription");
  if (!sub.repo.private) return json(sub);
  const denied = await checkPrivateAccess(request, env, accountId, sub.repo.full_name);
  if (denied) {
    if (denied.status === 403) await repoHubStub(env, sub.repo.id).endSubscription(id, "watch.unverified", "access_denied");
    return denied;
  }
  const until = Date.now() + PRIVATE_VERIFY_SECONDS * 1000;
  const updated = await repoHubStub(env, sub.repo.id).reverify(id, until);
  if (!updated) {
    // RepoHub ended it meanwhile (the PR merged, say); the index is stale.
    await account.removeSubscription(inbox, id);
    return problem(404, "not_found", "No such subscription");
  }
  await account.setVerified(id, until);
  return json({ ...sub, verified_until: new Date(until).toISOString() });
}

export async function deleteSubscription(env: Env, account: AccountStub, inbox: string, id: string): Promise<Response> {
  const sub = await account.removeSubscription(inbox, id);
  if (!sub) return problem(404, "not_found", "No such subscription");
  await repoHubStub(env, sub.repo.id).unsubscribe(id);
  return new Response(null, { status: 204 });
}

// The repo's first `base` or `author` filter: RepoHub learns its open PRs
// (the 100 most recently updated; others from their next event), so PRs
// opened before can match. Best effort: the subscription stands anyway.
async function rememberOpenPrs(
  env: Env,
  installation: DurableObjectStub<Installation>,
  installationId: number,
  fullName: string,
  repoId: number,
): Promise<void> {
  try {
    const minted = await installation.token(installationId, 1);
    if (!minted.ok) return;
    const res = await githubGet(minted.token, `/repos/${fullName}/pulls?state=open&sort=updated&direction=desc&per_page=100`);
    if (!res?.ok) {
      console.error(`listing ${fullName}'s open PRs: ${res ? res.status : "unreachable"}`);
      return;
    }
    const open: OpenPr[] = ((await res.json()) as (PullBody & { number: number })[]).map((pr) => ({
      number: pr.number,
      head_sha: pr.head?.sha ?? null,
      base_ref: pr.base?.ref ?? null,
      author: pr.user?.login ?? null,
      draft: !!pr.draft,
    }));
    await repoHubStub(env, repoId).rememberOpenPrs(open);
  } catch (e) {
    console.error(`remembering ${fullName}'s open PRs failed`, e);
  }
}

// A branch name git would take, roughly: see git-check-ref-format.
function isBranchName(s: string): boolean {
  return BRANCH_NAME.test(s) && !s.startsWith("-") && !s.startsWith("/") && !s.endsWith("/") && !s.endsWith(".")
    && !s.endsWith(".lock") && !s.includes("..") && !s.includes("@{") && !s.includes("//");
}

// Checks the body's shape. Returns the request, or what's wrong with it.
function parseRequest(body: Record<string, unknown> | null): SubscriptionRequest | string {
  if (!body || typeof body !== "object") return "Body must be a JSON object";
  const { repo, pr, kinds, base, author, ignore, ttl_seconds } = body;
  if (typeof repo !== "string" || !REPO_NAME.test(repo)) return "repo must be owner/name";
  if (pr !== undefined && pr !== null && !(Number.isSafeInteger(pr) && (pr as number) > 0)) return "pr must be a pull request number";
  if (kinds !== undefined) {
    if (!Array.isArray(kinds) || kinds.length > MAX_KINDS || !kinds.every((k) => typeof k === "string" && KIND_PATTERN.test(k))) {
      return `kinds must be a list of at most ${MAX_KINDS} kinds or globs`;
    }
  }
  if ((pr === undefined || pr === null) && !(kinds as string[] | undefined)?.length) {
    return "A repository-wide subscription must name at least one kind";
  }
  if (base !== undefined || author !== undefined) {
    if (pr !== undefined && pr !== null) return "base and author are for repository-wide subscriptions; leave out pr";
    if (base !== undefined && !(typeof base === "string" && isBranchName(base))) return "base must be a branch name";
    if (author !== undefined && !(typeof author === "string" && LOGIN.test(author))) return "author must be a GitHub login";
  }
  let parsedIgnore: SubscriptionRequest["ignore"];
  if (ignore !== undefined) {
    if (!ignore || typeof ignore !== "object") return "ignore must be an object";
    const { self, bots, actors } = ignore as Record<string, unknown>;
    if ((self !== undefined && typeof self !== "boolean") || (bots !== undefined && typeof bots !== "boolean")) {
      return "ignore.self and ignore.bots must be booleans";
    }
    if (actors !== undefined && !(Array.isArray(actors) && actors.length <= MAX_ACTORS && actors.every((a) => typeof a === "string"))) {
      return `ignore.actors must be a list of at most ${MAX_ACTORS} logins`;
    }
    parsedIgnore = { self: self as boolean | undefined, bots: bots as boolean | undefined, actors: actors as string[] | undefined };
  }
  if (ttl_seconds !== undefined && !(Number.isSafeInteger(ttl_seconds) && (ttl_seconds as number) >= 60 && (ttl_seconds as number) <= MAX_TTL_SECONDS)) {
    return `ttl_seconds must be from 60 to ${MAX_TTL_SECONDS}`;
  }
  return {
    repo,
    ...(pr === undefined || pr === null ? {} : { pr: pr as number }),
    ...(kinds === undefined ? {} : { kinds: kinds as string[] }),
    ...(base === undefined ? {} : { base: base as string }),
    ...(author === undefined ? {} : { author: author as string }),
    ...(parsedIgnore ? { ignore: parsedIgnore } : {}),
    ...(ttl_seconds === undefined ? {} : { ttl_seconds: ttl_seconds as number }),
  };
}

// The token must be this App's, for the same GitHub user as the API key,
// and able to read the repo. A GitHub App user token sees only repos both
// the user and the App can reach. Returns the refusal, or null.
async function checkPrivateAccess(request: Request, env: Env, accountId: number, fullName: string): Promise<Response | null> {
  const token = request.headers.get("X-GitHub-Token");
  if (!token) return problem(401, "github_token_required", `${fullName} is private: send your GitHub token as X-GitHub-Token`);
  const check = await checkUserToken(env, token);
  if (!check.ok) {
    return check.reason === "invalid"
      ? problem(401, "github_token_invalid", "GitHub didn't recognise this token as one issued to this server's App")
      : unavailable("Couldn't check the token with GitHub");
  }
  if (check.user.id !== accountId) {
    return problem(401, "github_token_invalid", "The GitHub token is for a different user than the API key");
  }
  const res = await githubGet(token, `/repos/${fullName}`);
  if (!res) return unavailable("Couldn't reach GitHub");
  if (res.status === 404 || res.status === 403) return problem(403, "repo_access_denied", `You can't read ${fullName}`);
  if (!res.ok) return unavailable(`GitHub answered ${res.status} for the repository`);
  return null;
}

function notInstalled(env: Env, repo: string): Response {
  const url = installUrl(env);
  return problem(409, "app_not_installed", `The watcheroni App isn't installed on ${repo}`, url ? { install_url: url } : {});
}

// A GET to GitHub's REST API, or null if GitHub couldn't be reached.
async function githubGet(token: string, path: string): Promise<Response | null> {
  try {
    return await fetch(`${GITHUB_API_URL}${path}`, { headers: githubHeaders(token) });
  } catch (e) {
    console.error(`GET ${path} failed`, e);
    return null;
  }
}

interface PullBody {
  state: "open" | "closed";
  merged?: boolean;
  merged_at?: string | null;
  draft?: boolean;
  head?: { sha?: string };
  base?: { ref?: string };
  user?: { login?: string };
}

function toBaseline(pr: PullBody): PrBaseline {
  return {
    state: pr.state === "open" ? "open" : pr.merged || pr.merged_at ? "merged" : "closed",
    head_sha: pr.head?.sha ?? null,
    base_ref: pr.base?.ref ?? null,
    draft: !!pr.draft,
  };
}
