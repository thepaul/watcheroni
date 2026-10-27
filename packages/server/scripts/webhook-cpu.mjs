#!/usr/bin/env node
// Measures Worker CPU for POST /github/webhook (signature check, parse,
// normalise) on the deployed Worker, with GitHub's example payloads and
// enlarged versions of them. The free plan allows 10 ms of CPU a request.
//
// Usage (from packages/server, logged in with wrangler):
//   node scripts/webhook-cpu.mjs --url https://watcheroni-proto.<you>.workers.dev \
//     --secret <GITHUB_WEBHOOK_SECRET> [--repeat 20]
//
// CPU comes from `wrangler tail`, which reports it per request in whole
// milliseconds; repeating each payload gives a usable average.

import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";

const { values: opts } = parseArgs({
  options: {
    url: { type: "string" },
    secret: { type: "string", default: process.env.GITHUB_WEBHOOK_SECRET },
    repeat: { type: "string", default: "20" },
  },
});
if (!opts.url || !opts.secret) {
  console.error("usage: webhook-cpu.mjs --url <worker url> --secret <GITHUB_WEBHOOK_SECRET> [--repeat N]");
  process.exit(2);
}
const base = opts.url.replace(/\/$/, "");
const repeat = Number(opts.repeat);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Payloads ------------------------------------------------------------

const examples = createRequire(import.meta.url)("@octokit/webhooks-examples");
const find = (event, action) => structuredClone(
  examples.find((e) => e.name === event).examples.find((x) => x.action === action),
);

// GitHub caps bodies, comments and check output at 65,536 characters. An
// emoji is 4 bytes of UTF-8, so this is the largest such field can be.
const MAX_TEXT = "🐙".repeat(65_536 / 2);
const label = (i) => ({ id: i, node_id: `L_${i}`, url: "https://api.github.com/x", name: `label-${i}`, color: "ededed", default: false, description: "x".repeat(100) });
const user = find("pull_request", "opened").sender;

function bigPullRequest() {
  const p = find("pull_request", "opened");
  p.pull_request.body = MAX_TEXT;
  p.pull_request.title = "t".repeat(256);
  p.pull_request.labels = Array.from({ length: 100 }, (_, i) => label(i));
  p.pull_request.assignees = Array(10).fill(user);
  p.pull_request.requested_reviewers = Array(15).fill(user);
  return p;
}
function bigComment() {
  const p = find("issue_comment", "created");
  p.comment.body = MAX_TEXT;
  p.issue.body = MAX_TEXT;
  p.issue.labels = Array.from({ length: 100 }, (_, i) => label(i));
  return p;
}
function bigCheckRun() {
  const p = find("check_run", "completed");
  p.check_run.conclusion = "failure";
  p.check_run.output = { title: "t".repeat(1000), summary: MAX_TEXT, text: MAX_TEXT, annotations_count: 50 };
  p.check_run.pull_requests = Array.from({ length: 20 }, (_, i) => ({ ...p.check_run.pull_requests?.[0], number: i + 1 }));
  return p;
}
// Not a real event: a large payload with nothing to normalise, to see how
// CPU grows with size alone.
function padded(bytes) {
  const p = find("pull_request", "labeled");
  p.padding = "x".repeat(bytes);
  return p;
}

const fixtures = [
  ["pull_request.opened", "pull_request", find("pull_request", "opened")],
  ["pull_request.synchronize", "pull_request", find("pull_request", "synchronize")],
  ["pull_request_review.submitted", "pull_request_review", find("pull_request_review", "submitted")],
  ["review_comment.created", "pull_request_review_comment", find("pull_request_review_comment", "created")],
  ["issue_comment.created", "issue_comment", find("issue_comment", "created")],
  ["check_run.completed", "check_run", find("check_run", "completed")],
  ["workflow_run.completed", "workflow_run", find("workflow_run", "completed")],
  ["big pull_request.opened", "pull_request", bigPullRequest()],
  ["big issue_comment.created", "issue_comment", bigComment()],
  ["big check_run.completed", "check_run", bigCheckRun()],
  ["padded 1 MB", "pull_request", padded(1_000_000)],
  ["padded 5 MB", "pull_request", padded(5_000_000)],
].map(([name, event, payload], i) => ({ name, key: `f${i}`, event, body: Buffer.from(JSON.stringify(payload)) }));

// --- Tail ----------------------------------------------------------------

const tail = spawn("npx", ["wrangler", "tail", "--format", "json"], { stdio: ["ignore", "pipe", "pipe"] });
let buffer = "";
const records = [];
tail.stdout.on("data", (chunk) => {
  buffer += chunk;
  // wrangler prints one pretty-printed object per event, closed by "}" on
  // a line of its own.
  let end;
  while ((end = buffer.indexOf("\n}\n")) !== -1) {
    const text = buffer.slice(0, end + 2);
    buffer = buffer.slice(end + 3);
    try {
      records.push(JSON.parse(text));
    } catch {
      // Not an event.
    }
  }
});
// In JSON mode wrangler doesn't say when it has connected; give it time.
tail.stderr.resume();
await sleep(15_000);

// --- Send ----------------------------------------------------------------

const statuses = new Map();
for (const f of fixtures) {
  const signature = "sha256=" + createHmac("sha256", opts.secret).update(f.body).digest("hex");
  for (let i = 0; i < repeat; i++) {
    const res = await fetch(`${base}/github/webhook?fixture=${f.key}`, {
      method: "POST",
      headers: {
        "X-GitHub-Event": f.event,
        "X-GitHub-Delivery": randomUUID(),
        "X-Hub-Signature-256": signature,
        "content-type": "application/json",
      },
      body: f.body,
    });
    await res.arrayBuffer();
    // Tail samples when requests come quickly; spacing them out keeps
    // nearly all of them.
    await sleep(300);
    statuses.set(f.key, [...(statuses.get(f.key) ?? []), res.status]);
  }
  process.stdout.write(".");
}
console.log("\nwaiting for tail to catch up...");
for (let i = 0; i < 30 && records.filter((r) => r.event?.request?.url?.includes("fixture=")).length < fixtures.length * repeat; i++) {
  await sleep(1000);
}
tail.kill();

// --- Report --------------------------------------------------------------

const quantile = (xs, q) => xs.length ? xs[Math.min(xs.length - 1, Math.floor(q * xs.length))] : null;
const rows = fixtures.map((f) => {
  const seen = records.filter((r) => new URL(r.event?.request?.url ?? "https://x").searchParams.get("fixture") === f.key);
  const cpu = seen.map((r) => r.cpuTime).sort((a, b) => a - b);
  const codes = [...new Set(statuses.get(f.key))].join(",");
  return {
    payload: f.name,
    KB: Math.round(f.body.length / 1024),
    status: codes,
    seen: `${seen.length}/${repeat}`,
    "cpu mean ms": cpu.length ? +(cpu.reduce((a, b) => a + b, 0) / cpu.length).toFixed(1) : null,
    "p50": quantile(cpu, 0.5),
    "p95": quantile(cpu, 0.95),
    "max": cpu.at(-1) ?? null,
    outcomes: [...new Set(seen.map((r) => r.outcome))].join(","),
  };
});
console.table(rows);
console.log("The free plan's limit is 10 ms CPU per request; the first request to a new isolate also pays for startup.");
