import { execFileSync } from "node:child_process";

// GitHub access for local mode. The token stays on this machine: it is
// never sent to a watcheroni server.

export class LoginNeeded extends Error {}

export class GitHubError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

let cached: string | undefined;

export function githubToken(): string {
  if (cached) return cached;
  const fromEnv = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (fromEnv) return (cached = fromEnv);
  try {
    const out = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (out) return (cached = out);
  } catch {
    // gh missing or not signed in.
  }
  throw new LoginNeeded("No GitHub credentials: run `gh auth login`, or set GH_TOKEN or GITHUB_TOKEN.");
}

export async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${githubToken()}`,
      "content-type": "application/json",
      "user-agent": "watcheroni-cli",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401) throw new LoginNeeded("GitHub rejected the token: run `gh auth login`, or check GH_TOKEN.");
  if (!res.ok) throw new GitHubError(`GitHub GraphQL: ${res.status} ${await res.text()}`, res.status);
  const body = (await res.json()) as { data?: T; errors?: { type?: string; message: string }[] };
  if (body.errors?.length) {
    const notFound = body.errors.some((e) => e.type === "NOT_FOUND");
    throw new GitHubError(body.errors.map((e) => e.message).join("; "), notFound ? 404 : 502);
  }
  return body.data as T;
}
