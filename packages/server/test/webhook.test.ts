import examples from "@octokit/webhooks-examples/api.github.com/index.json";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sign } from "../src/webhook/signature";
import type { WatchEvent } from "../src/protocol";

type Example = { action?: string; [key: string]: unknown };
const byEvent = new Map((examples as { name: string; examples: Example[] }[]).map((e) => [e.name, e.examples]));
const example = (event: string, action: string, pick: (e: Example) => boolean = () => true) => {
  const found = byEvent.get(event)?.find((e) => e.action === action && pick(e));
  if (!found) throw new Error(`no ${event}.${action} example`);
  return found;
};

async function post(event: string, payload: unknown, opts: { signature?: string; delivery?: string } = {}) {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  return exports.default.fetch("https://example.com/github/webhook", {
    method: "POST",
    headers: {
      "X-GitHub-Event": event,
      "X-GitHub-Delivery": opts.delivery ?? "delivery-1",
      "X-Hub-Signature-256": opts.signature ?? (await sign(body, "test-secret")),
      "content-type": "application/json",
    },
    body,
  });
}

async function events(event: string, payload: unknown): Promise<Omit<WatchEvent, "seq">[]> {
  const res = await post(event, payload);
  expect(res.status).toBe(202);
  return ((await res.json()) as { events: Omit<WatchEvent, "seq">[] }).events;
}

describe("webhook signature", () => {
  it("rejects a wrong or missing signature", async () => {
    const payload = example("pull_request", "opened");
    const wrong = await sign(new TextEncoder().encode("something else"), "test-secret");
    expect((await post("pull_request", payload, { signature: wrong })).status).toBe(401);
    expect((await post("pull_request", payload, { signature: "sha256=zz" })).status).toBe(401);
    expect((await post("pull_request", payload, { signature: "" })).status).toBe(401);
  });

  it("refuses bodies over 2 MB", async () => {
    const payload = { ...example("pull_request", "labeled"), padding: "x".repeat(2 * 1024 * 1024) };
    expect((await post("pull_request", payload)).status).toBe(413);
  });

  it("needs no API key", async () => {
    expect((await post("pull_request", example("pull_request", "opened"))).status).toBe(202);
  });
});

describe("normalising", () => {
  it("pull_request actions", async () => {
    const payload = example("pull_request", "opened") as { pull_request: { user: { login: string }; base: { ref: string } } };
    const opened = await events("pull_request", payload);
    expect(opened).toHaveLength(2);
    expect(opened[0]).toMatchObject({
      v: 1,
      id: "delivery-1.0",
      kind: "pr.opened",
      pr: expect.any(Number),
      repo: { id: expect.any(Number), full_name: expect.any(String) },
      actor: { login: expect.any(String) },
      data: { head_sha: expect.stringMatching(/^[0-9a-f]{40}$/), base: expect.any(String) },
    });
    // Last, for RepoHub only: what base and author filters match on.
    expect(opened[1]).toMatchObject({
      id: "delivery-1.1",
      kind: "pr.seen",
      pr: opened[0].pr,
      data: { head_sha: opened[0].data.head_sha, base: payload.pull_request.base.ref, author: payload.pull_request.user.login, state: "open" },
    });
    expect((await events("pull_request", example("pull_request", "synchronize")))[0].kind).toBe("pr.pushed");
    const closed = example("pull_request", "closed");
    const kind = (closed.pull_request as { merged: boolean }).merged ? "pr.merged" : "pr.closed";
    expect((await events("pull_request", closed))[0].kind).toBe(kind);
    expect((await events("pull_request", example("pull_request", "review_requested")))[0].data.reviewer).toEqual(expect.any(String));
    expect(await events("pull_request", example("pull_request", "labeled"))).toEqual([]);
  });

  it("reviews, comments and threads", async () => {
    const submitted = example("pull_request_review", "submitted") as Example & { review: { body: string | null } };
    const review = await events("pull_request_review", submitted);
    expect(review[0]).toMatchObject({
      kind: "review.submitted", data: { review_id: expect.any(Number), state: expect.stringMatching(/^[a-z_]+$/), has_body: false },
    });
    const withBody = await events("pull_request_review", { ...submitted, review: { ...submitted.review, body: "Some notes" } });
    expect(withBody[0].data.has_body).toBe(true);
    const created = example("pull_request_review_comment", "created") as Example & { comment: { line: number | null; original_line: number } };
    const comment = await events("pull_request_review_comment", created);
    expect(comment[0]).toMatchObject({ kind: "review_comment.created", data: { comment_id: expect.any(Number), path: expect.any(String) } });
    // An outdated comment keeps its original line.
    const outdated = await events("pull_request_review_comment", { ...created, comment: { ...created.comment, line: null, original_line: 4 } });
    expect(outdated[0].data.line).toBe(4);
    const thread = await events("pull_request_review_thread", example("pull_request_review_thread", "resolved"));
    expect(thread[0]).toMatchObject({
      kind: "thread.resolved",
      data: { thread_node_id: expect.any(String), path: expect.any(String), line: expect.any(Number), comment_id: expect.any(Number) },
      links: { api: expect.stringMatching(/\/pulls\/comments\/\d+$/) },
    });
    const issueComment = await events("issue_comment", example("issue_comment", "created"));
    expect(issueComment[0].kind).toBe("comment.created");
    // A comment on a PR says who opened it.
    const onPr = structuredClone(example("issue_comment", "created")) as { issue: { pull_request?: object; user: { login: string } } };
    onPr.issue.pull_request = {};
    expect((await events("issue_comment", onPr)).map((e) => [e.kind, e.data.author ?? null])).toEqual([
      ["comment.created", null],
      ["pr.seen", onPr.issue.user.login],
    ]);
  });

  it("checks", async () => {
    const run = example("check_run", "completed");
    const out = await events("check_run", run);
    const r = run.check_run as { id: number; name: string; head_sha: string; conclusion: string; html_url: string; url: string };
    expect(out[0]).toMatchObject({
      kind: "check.completed",
      data: { head_sha: r.head_sha, name: r.name, check_run_id: r.id, conclusion: r.conclusion },
      links: { html: r.html_url, api: r.url },
    });
    expect(Object.keys(out[0].data).sort()).toEqual(["check_run_id", "conclusion", "head_sha", "name"]);
    const failed = structuredClone(run);
    (failed.check_run as { conclusion: string }).conclusion = "failure";
    const both = await events("check_run", failed);
    expect(both.map((e) => e.kind)).toEqual(["check.completed", "check.failed"]);
    expect(both[1].data).toEqual(both[0].data);
    // A run starting, a pending status and a check suite say nothing.
    const started = structuredClone(example("check_run", "created"));
    Object.assign(started.check_run as object, { status: "queued", conclusion: null });
    expect(await events("check_run", started)).toEqual([]);
    const statusExample = byEvent.get("status")![0];
    expect(await events("status", { ...statusExample, state: "pending" })).toEqual([]);
    expect(await events("check_suite", example("check_suite", "completed"))).toEqual([]);
    const status = await events("status", { ...statusExample, state: "error", context: "ci/x" });
    expect(status.map((e) => [e.kind, e.data])).toEqual([
      ["check.completed", { head_sha: expect.any(String), name: "ci/x", status_context: "ci/x", conclusion: "failure" }],
      ["check.failed", { head_sha: expect.any(String), name: "ci/x", status_context: "ci/x", conclusion: "failure" }],
    ]);
    const wf = await events("workflow_run", example("workflow_run", "completed"));
    expect(wf[0]).toMatchObject({ kind: "workflow.completed", data: { run_id: expect.any(Number) } });
  });

  it("numbers events within a delivery", async () => {
    const run = structuredClone(example("check_run", "completed"));
    (run.check_run as { conclusion: string; pull_requests: { number: number }[] }).conclusion = "failure";
    (run.check_run as { pull_requests: { number: number }[] }).pull_requests = [{ number: 1 }, { number: 2 }];
    const out = await events("check_run", run);
    expect(out.map((e) => [e.id, e.kind, e.pr])).toEqual([
      ["delivery-1.0", "check.completed", 1],
      ["delivery-1.1", "check.failed", 1],
      ["delivery-1.2", "check.completed", 2],
      ["delivery-1.3", "check.failed", 2],
    ]);
  });

  it("keeps no text from any example", async () => {
    const texts = (p: Record<string, unknown>) => {
      const found: string[] = [];
      for (const key of ["pull_request", "issue", "comment", "review"]) {
        const o = p[key] as { title?: unknown; body?: unknown } | undefined;
        for (const t of [o?.title, o?.body]) if (typeof t === "string" && t.length > 8) found.push(t);
      }
      return found;
    };
    let checked = 0;
    for (const [event, list] of byEvent) {
      for (const payload of list) {
        const out = JSON.stringify(await events(event, payload));
        for (const t of texts(payload)) {
          expect(out).not.toContain(t);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });
});
