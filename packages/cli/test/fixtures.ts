import type { Check, Snapshot } from "../src/snapshot.ts";

export const HEAD1 = "1".repeat(40);
export const HEAD2 = "2".repeat(40);
export const alice = { id: 1, login: "alice", bot: false };
export const bob = { id: 2, login: "bob", bot: false };

export function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    fetchedAt: "2026-10-27T00:00:00Z",
    repo: { id: 99, full_name: "octo/widgets" },
    number: 7,
    url: "https://github.com/octo/widgets/pull/7",
    state: "OPEN",
    draft: false,
    head: HEAD1,
    base: "main",
    mergeSha: null,
    requested: [],
    reviews: [],
    reviewComments: [],
    threads: [],
    comments: [],
    checks: [],
    ...over,
  };
}

export function check(name: string, over: Partial<Check> = {}): Check {
  return {
    key: `check_run:${name}`,
    name,
    type: "check_run",
    checkRunId: name.length,
    workflowRunId: 500,
    workflow: "CI",
    done: true,
    conclusion: "success",
    url: `https://github.com/octo/widgets/actions/runs/500/job/${name}`,
    at: "2026-10-27T00:01:00Z",
    ...over,
  };
}

