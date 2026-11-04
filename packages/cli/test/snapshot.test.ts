import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("leaves the runs out when the token can't read Actions, and retries when out of requests", async () => {
    for (const status of [403, 404]) {
      runs = () => new Response("Resource not accessible by personal access token", { status });
      expect((await fetchSnapshot({ ...target, number: 8 })).workflowRuns).toBeNull();
    }
    for (const headers of [{ "x-ratelimit-remaining": "0" }, { "retry-after": "60" }]) {
      runs = () => new Response("API rate limit exceeded", { status: 403, headers });
      await expect(fetchSnapshot({ ...target, number: 8 })).rejects.toMatchObject({ status: 429 });
    }
  });
});
