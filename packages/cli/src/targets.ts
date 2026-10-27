import { execFileSync } from "node:child_process";
import { LoginNeeded, graphql } from "./github.ts";

export interface Target { owner: string; name: string; number: number }

export const targetKey = (t: Target) => `${t.owner}/${t.name}#${t.number}`;

export class UsageError extends Error {}

// `owner/repo#123` or a PR URL. Repository-wide targets (`owner/repo`)
// need the server, which local mode doesn't have.
export function parseTarget(arg: string): Target {
  const short = arg.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  const url = arg.match(/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/);
  const m = short ?? url;
  if (m) return { owner: m[1], name: m[2], number: Number(m[3]) };
  if (/^[\w.-]+\/[\w.-]+$/.test(arg)) {
    throw new UsageError(`${arg}: watching a whole repository needs the watcheroni server; name a PR (${arg}#123)`);
  }
  throw new UsageError(`${arg}: expected owner/repo#123 or a pull request URL`);
}

// GitHub repositories named by this checkout's remotes, upstream first,
// since a fork's PRs are opened against upstream.
export function remoteRepos(cwd = process.cwd()): { owner: string; name: string }[] {
  let out: string;
  try {
    out = execFileSync("git", ["remote", "-v"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return [];
  }
  const repos = new Map<string, { remote: string; owner: string; name: string }>();
  for (const line of out.split("\n")) {
    const m = line.match(/^(\S+)\s+(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?\s/);
    if (m && !repos.has(`${m[2]}/${m[3]}`)) repos.set(`${m[2]}/${m[3]}`, { remote: m[1], owner: m[2], name: m[3] });
  }
  const rank = (r: string) => (r === "upstream" ? 0 : r === "origin" ? 1 : 2);
  return [...repos.values()].sort((a, b) => rank(a.remote) - rank(b.remote)).map(({ owner, name }) => ({ owner, name }));
}

// No target given: the open PR for the current branch.
export async function currentBranchPr(cwd = process.cwd()): Promise<Target> {
  let branch = "";
  try {
    branch = execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    // Not a git checkout.
  }
  if (!branch) throw new UsageError("Not on a git branch; name a PR (owner/repo#123)");
  const repos = remoteRepos(cwd);
  if (!repos.length) throw new UsageError("No GitHub remote in this checkout; name a PR (owner/repo#123)");
  for (const repo of repos) {
    const data = await graphql<{ repository: { pullRequests: { nodes: { number: number }[] } } | null }>(
      `query($owner: String!, $name: String!, $branch: String!) {
        repository(owner: $owner, name: $name) {
          pullRequests(headRefName: $branch, states: OPEN, first: 1, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { number } }
        }
      }`,
      { ...repo, branch },
    ).catch((e) => {
      if (e instanceof LoginNeeded) throw e;
      return null;
    });
    const number = data?.repository?.pullRequests.nodes[0]?.number;
    if (number) return { ...repo, number };
  }
  throw new UsageError(`No open PR for branch ${branch} in ${repos.map((r) => `${r.owner}/${r.name}`).join(" or ")}`);
}
