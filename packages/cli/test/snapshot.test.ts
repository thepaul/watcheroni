import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginNeeded, REST_CACHE_SIZE, clearRestCache, restList } from "../src/github.ts";
import { fetchSnapshot } from "../src/snapshot.ts";
import { HEAD1 } from "./fixtures.ts";

// fetchSnapshot against a stand-in GitHub: the GraphQL query, then the head
// commit's workflow runs, asked for again with the ETag.

const pr = {
  number: 7, url: "https://github.com/octo/widgets/pull/7", state: "OPEN", isDraft: false,
  headRefOid: HEAD1, baseRefName: "main", mergeCommit: null,
  reviewRequests: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] }, comments: { nodes: [] },
  commits: { nodes: [] },
};
const graphqlBody = { data: { repository: { databaseId: 99, nameWithOwner: "octo/widgets", pullRequest: pr } } };
const runsBody = {
  total_count: 1,
  workflow_runs: [{
    id: 500, run_attempt: 2, name: "CI", status: "completed", conclusion: "failure",
    html_url: "https://github.com/octo/widgets/actions/runs/500",
    url: "https://api.github.com/repos/octo/widgets/actions/runs/500",
    updated_at: "2026-10-27T00:03:00Z",
  }],
};
const target = { owner: "octo", name: "widgets", number: 7 };

describe("fetchSnapshot", () => {
  let runs: (headers: Headers, url: string) => Response;
  const asked: { url: string; headers: Headers }[] = [];

  beforeEach(() => {
    process.env.GH_TOKEN = "test-token";
    asked.length = 0;
    clearRestCache();
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      asked.push({ url, headers });
      if (url.endsWith("/graphql")) return Response.json(graphqlBody);
      return runs(headers, url);
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reads the head commit's workflow runs, again only if they changed", async () => {
    runs = (h) => h.get("if-none-match") === '"v1"'
      ? new Response(null, { status: 304 })
      : Response.json(runsBody, { headers: { etag: '"v1"' } });
    const first = await fetchSnapshot(target);
    expect(asked[1].url).toBe(`https://api.github.com/repos/octo/widgets/actions/runs?head_sha=${HEAD1}&per_page=100&exclude_pull_requests=true`);
    expect(first.workflowRuns).toEqual([{
      id: 500, attempt: 2, name: "CI", done: true, conclusion: "failure",
      url: runsBody.workflow_runs[0].html_url, api: runsBody.workflow_runs[0].url, at: "2026-10-27T00:03:00Z",
    }]);
    const second = await fetchSnapshot(target);
    expect(asked[3].headers.get("if-none-match")).toBe('"v1"');
    expect(second.workflowRuns).toEqual(first.workflowRuns);
  });

  it("follows the Link header to every page", async () => {
    const page2 = "https://api.github.com/repositories/99/actions/runs?head_sha=x&page=2";
    const other = { ...runsBody.workflow_runs[0], id: 600, name: "Docs" };
    runs = (h, url) => {
      const etag = url === page2 ? '"p2"' : '"p1"';
      if (h.get("if-none-match") === etag) return new Response(null, { status: 304 });
      // Run 500 moved to page 2 between the two requests: it's kept once.
      return url === page2
        ? Response.json({ workflow_runs: [runsBody.workflow_runs[0], other] }, { headers: { etag } })
        : Response.json(runsBody, { headers: { etag, link: `<${page2}>; rel="next", <${page2}>; rel="last"` } });
    };
    const first = await fetchSnapshot(target);
    expect(asked.map((a) => a.url).slice(1)).toEqual([expect.stringContaining("/actions/runs?head_sha="), page2]);
    expect(first.workflowRuns?.map((r) => r.id)).toEqual([500, 600]);
    // Both pages unchanged: both answered 304, from what was kept.
    expect((await fetchSnapshot(target)).workflowRuns).toEqual(first.workflowRuns);
    expect(asked.slice(4).map((a) => a.headers.get("if-none-match"))).toEqual(['"p1"', '"p2"']);
  });

  it("sends the token to GitHub's API only, and reads each page once", async () => {
    const elsewhere = "https://evil.example/repos/octo/widgets/actions/runs?page=2";
    runs = (_h, url) => url === elsewhere
      ? Response.json(runsBody)
      : Response.json(runsBody, { headers: { link: `<${elsewhere}>; rel="next"` } });
    expect((await fetchSnapshot(target)).workflowRuns).toBeNull();
    expect(asked.map((a) => a.url)).not.toContain(elsewhere);

    // A `next` that leads back to a page already read.
    asked.length = 0;
    const page2 = "https://api.github.com/repositories/99/actions/runs?page=2";
    runs = (_h, url) => Response.json(runsBody, { headers: { link: `<${url === page2 ? asked[1].url : page2}>; rel="next"` } });
    expect((await fetchSnapshot(target)).workflowRuns).toBeNull();
    expect(asked.length).toBe(3);

    // One that never ends.
    asked.length = 0;
    runs = (_h, url) => Response.json(runsBody, { headers: { link: `<${url.replace(/&n=\d+$/, "")}&n=${asked.length}>; rel="next"` } });
    expect((await fetchSnapshot(target)).workflowRuns).toBeNull();
    expect(asked.length).toBe(1 + 20);
  });

  it("leaves the runs out when they can't be read, and retries when out of requests", async () => {
    // No access, GitHub failing, the network failing, a run without an attempt.
    const unreadable: (() => Response)[] = [
      () => new Response("Resource not accessible by personal access token", { status: 403 }),
      () => new Response("Not Found", { status: 404 }),
      () => new Response("Server Error", { status: 502 }),
      () => { throw new TypeError("fetch failed"); },
      () => Response.json({ workflow_runs: [{ ...runsBody.workflow_runs[0], run_attempt: undefined }] }),
    ];
    const why: (string | undefined)[] = [];
    for (const r of unreadable) {
      runs = r;
      const s = await fetchSnapshot(target);
      expect(s.workflowRuns).toBeNull();
      why.push(s.workflowRunsError);
    }
    const path = "GitHub /repos/octo/widgets/actions/runs";
    expect(why).toEqual([
      `${path}: 403 Resource not accessible by personal access token`,
      `${path}: 404 Not Found`,
      `${path}: 502 Server Error`,
      "fetch failed",
      "workflow run 500 has no run_attempt",
    ]);
    // GitHub's JSON error body is reduced to its message.
    runs = () => Response.json({ message: "Must have admin rights", documentation_url: "https://docs.github.com/x" }, { status: 403 });
    expect((await fetchSnapshot(target)).workflowRunsError).toBe(`${path}: 403 Must have admin rights`);
    // Readable runs have no error.
    runs = () => Response.json(runsBody);
    expect((await fetchSnapshot(target)).workflowRunsError).toBeUndefined();

    const limited: (() => Response)[] = [
      () => new Response("API rate limit exceeded", { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
      () => new Response("You have exceeded a secondary rate limit", { status: 403, headers: { "retry-after": "60" } }),
      () => new Response("Too Many Requests", { status: 429 }),
    ];
    for (const r of limited) {
      runs = r;
      await expect(fetchSnapshot(target)).rejects.toMatchObject({ status: 429 });
    }
    // A token GitHub rejects stops the poll too.
    runs = () => new Response("Bad credentials", { status: 401 });
    await expect(fetchSnapshot(target)).rejects.toBeInstanceOf(LoginNeeded);
  });

  it("keeps the most recently used pages", async () => {
    runs = (h, url) => h.get("if-none-match") === `"${url}"`
      ? new Response(null, { status: 304 })
      : Response.json({ items: [url] }, { headers: { etag: `"${url}"` } });
    const pick = (body: unknown) => (body as { items: string[] }).items;
    for (let i = 0; i <= REST_CACHE_SIZE; i++) await restList(`/list/${i}`, pick);
    // /list/0 was used least recently, and has gone; /list/1 hasn't.
    expect(await restList("/list/1", pick)).toEqual(["https://api.github.com/list/1"]);
    await restList("/list/0", pick);
    expect(asked.slice(-2).map((a) => a.headers.get("if-none-match"))).toEqual(['"https://api.github.com/list/1"', null]);
    // Asking for /list/1, answered 304, made it recent: /list/2 went when
    // /list/0 came back.
    await restList("/list/2", pick);
    await restList("/list/1", pick);
    expect(asked.slice(-2).map((a) => a.headers.get("if-none-match"))).toEqual([null, '"https://api.github.com/list/1"']);
  });
});
