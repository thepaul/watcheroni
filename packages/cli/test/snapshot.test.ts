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
  let runs: (headers: Headers) => Response;
  const asked: { url: string; headers: Headers }[] = [];

  beforeEach(() => {
    process.env.GH_TOKEN = "test-token";
    asked.length = 0;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      asked.push({ url, headers });
      if (url.endsWith("/graphql")) return Response.json(graphqlBody);
      return runs(headers);
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

  it("leaves the runs out when the token can't read Actions, and retries when out of requests", async () => {
    runs = () => new Response("Resource not accessible by personal access token", { status: 403 });
    expect((await fetchSnapshot({ ...target, number: 8 })).workflowRuns).toBeNull();
    runs = () => new Response("API rate limit exceeded", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
    await expect(fetchSnapshot({ ...target, number: 8 })).rejects.toMatchObject({ status: 429 });
  });
});
