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

const API = "https://api.github.com/";

// Earlier pages of REST lists, by URL, keeping only what the caller took
// from them, least recently used first. Asking again with the ETag costs
// nothing from the rate limit when GitHub answers 304 Not Modified. Room
// for a page or two of each of a few hundred watched PRs; a PR's earlier
// heads aren't asked about again, and go first.
export const REST_CACHE_SIZE = 500;
const etags = new Map<string, { etag: string; items: unknown[]; next: string | null }>();

export function clearRestCache(): void {
  etags.clear();
}

// A list's pages to follow at most: GitHub gives at most 1,000 results
// (10 pages of 100) for a filtered list of workflow runs.
const MAX_PAGES = 20;

// Every page of a REST list, following the Link header's `next`. `pick`
// takes the wanted fields from a page's body.
export async function restList<T>(path: string, pick: (body: unknown) => T[]): Promise<T[]> {
  const out: T[] = [];
  const seen = new Set<string>();
  const where = path.replace(/\?.*/, "");
  for (let url: string | null = `${API}${path.replace(/^\//, "")}`; url;) {
    // The token goes to GitHub's API only, and each page once.
    if (!url.startsWith(API)) throw new GitHubError(`GitHub ${where}: next page outside ${API}: ${url}`, 502);
    if (seen.has(url)) throw new GitHubError(`GitHub ${where}: next page already read: ${url}`, 502);
    if (seen.size === MAX_PAGES) throw new GitHubError(`GitHub ${where}: more than ${MAX_PAGES} pages`, 502);
    seen.add(url);
    const cached = etags.get(url);
    if (cached) {
      etags.delete(url);
      etags.set(url, cached);
    }
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
      // Out of requests is worth trying again, unlike a 403 for no access:
      // a 403 that says so is reported as a 429, as GitHub also sends.
      const limited = res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after");
      const text = await res.text();
      let message = text;
      try {
        const parsed = (JSON.parse(text) as { message?: unknown } | null)?.message;
        if (typeof parsed === "string") message = parsed;
      } catch {
        // Not JSON: the text as it is.
      }
      throw new GitHubError(`GitHub ${where}: ${res.status} ${message}`, limited ? 429 : res.status);
    }
    const items = pick(await res.json());
    const next = res.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
    const etag = res.headers.get("etag");
    if (etag) {
      etags.delete(url);
      etags.set(url, { etag, items, next });
      for (const old of etags.keys()) if (etags.size > REST_CACHE_SIZE) etags.delete(old);
    }
    out.push(...items);
    url = next;
  }
  return out;
}
