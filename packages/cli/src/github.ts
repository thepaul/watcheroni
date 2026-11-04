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

// Earlier pages of REST lists, by URL, keeping only what the caller took
// from them. Asking again with the ETag costs nothing from the rate limit
// when GitHub answers 304 Not Modified.
const etags = new Map<string, { etag: string; items: unknown[]; next: string | null }>();

// Every page of a REST list, following the Link header's `next`. `pick`
// takes the wanted fields from a page's body.
export async function restList<T>(path: string, pick: (body: unknown) => T[]): Promise<T[]> {
  const out: T[] = [];
  for (let url: string | null = `https://api.github.com${path}`; url;) {
    const cached = etags.get(url);
    const res: Response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${githubToken()}`,
        accept: "application/vnd.github+json",
        "user-agent": "watcheroni-cli",
        ...(cached ? { "if-none-match": cached.etag } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 304 && cached) {
      out.push(...(cached.items as T[]));
      url = cached.next;
      continue;
    }
    if (res.status === 401) throw new LoginNeeded("GitHub rejected the token: run `gh auth login`, or check GH_TOKEN.");
    if (!res.ok) {
      // Out of requests is worth trying again, unlike a 403 for no access.
      const limited = res.status === 429 || res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after");
      throw new GitHubError(`GitHub ${path}: ${res.status} ${await res.text()}`, limited ? 429 : res.status);
    }
    const items = pick(await res.json());
    const next = res.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
    const etag = res.headers.get("etag");
    if (etag) {
      etags.delete(url);
      etags.set(url, { etag, items, next });
      // Oldest first: a PR's earlier heads aren't asked about again.
      for (const old of etags.keys()) if (etags.size > 100) etags.delete(old);
    }
    out.push(...items);
    url = next;
  }
  return out;
}
