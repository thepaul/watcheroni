import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Inbox } from "../src/inbox.ts";
import { FakeServer } from "./fake-server.ts";

// The CLI in server mode, run as a separate process against the fake
// server.

const MAIN = join(import.meta.dirname, "..", "src", "main.ts");

let fake: FakeServer;
let env: Record<string, string>;
let cwd: string;

beforeEach(async () => {
  fake = await new FakeServer().start();
  cwd = mkdtempSync(join(tmpdir(), "watcheroni-cli-"));
  env = {
    PATH: process.env.PATH!,
    HOME: cwd,
    WATCHERONI_STATE_DIR: join(cwd, "state"),
    WATCHERONI_CONFIG_DIR: join(cwd, "config"),
    WATCHERONI_SERVER: fake.url,
    WATCHERONI_API_KEY: fake.token,
    WATCHERONI_INBOX: "box",
  };
});
afterEach(() => fake.stop());

interface Run {
  code: Promise<number>;
  stdout: () => string;
  stderr: () => string;
  kill: () => void;
}

// `null` in extraEnv leaves that variable out.
function cli(args: string[], extraEnv: Record<string, string | null> = {}): Run {
  const merged = Object.entries({ ...env, ...extraEnv }).filter((kv): kv is [string, string] => kv[1] !== null);
  const child = spawn(process.execPath, [MAIN, ...args], { cwd, env: Object.fromEntries(merged) });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const code = new Promise<number>((r) => child.on("close", (c) => r(c ?? -1)));
  return { code, stdout: () => stdout, stderr: () => stderr, kill: () => child.kill("SIGTERM") };
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  for (let t = 0; t < ms && !check(); t += 20) await new Promise((r) => setTimeout(r, 20));
  expect(check()).toBe(true);
}

describe("wait against a server", () => {
  it("prints what's in the inbox, acknowledges it, and exits 0", async () => {
    fake.inject("box", "review.submitted", { review_id: 5, state: "approved" });
    fake.inject("box", "comment.created", { comment_id: 9 });
    const run = cli(["wait", "--settle", "0"]);
    expect(await run.code).toBe(0);
    expect(run.stdout()).toBe([
      "octo/widgets#7: 2 new events",
      "- review.submitted: approved",
      "  gh api repos/octo/widgets/pulls/7/reviews/5 --jq '.state, .body'",
      "- comment.created",
      "  gh api repos/octo/widgets/issues/comments/9 --jq .body",
      "",
      "Still reading inbox box. Run `watcheroni wait` again to keep watching.",
      "",
    ].join("\n"));
    expect(fake.inbox("box").acked).toBe(2);
    expect(run.stderr()).toBe("");
  });

  it("waits for events, settling, and prints JSON", async () => {
    const run = cli(["wait", "--settle", "1s", "--format", "json"]);
    await until(() => fake.sockets.size === 1);
    fake.inject("box", "check.failed");
    await new Promise((r) => setTimeout(r, 300));
    fake.inject("box", "checks.completed");
    expect(await run.code).toBe(0);
    const out = JSON.parse(run.stdout()) as { events: { kind: string }[]; watching: string[] };
    expect(out.events.map((e) => e.kind)).toEqual(["check.failed", "checks.completed"]);
    expect(out.watching).toEqual([]);
    expect(fake.inbox("box").acked).toBe(2);
  });

  it("filters kinds, acknowledging the ones skipped", async () => {
    fake.inject("box", "comment.created");
    fake.inject("box", "check.failed");
    const run = cli(["wait", "--settle", "0", "--kinds", "check.*", "--format", "json"]);
    expect(await run.code).toBe(0);
    expect((JSON.parse(run.stdout()) as { events: { seq: number }[] }).events.map((e) => e.seq)).toEqual([2]);
    expect(fake.inbox("box").acked).toBe(2);
  });

  it("shows a reply once, but its review to a review.* filter", async () => {
    const reply = () => {
      fake.inject("box", "review.submitted", { review_id: 5, state: "commented", has_body: false });
      fake.inject("box", "review_comment.created", { comment_id: 6, review_id: 5, path: "a.ts", line: 3, in_reply_to: 4 });
    };
    reply();
    let run = cli(["wait", "--settle", "0"]);
    expect(await run.code).toBe(0);
    expect(run.stdout().split("\n").slice(0, 3)).toEqual([
      "octo/widgets#7: 2 new events",
      "- review_comment.created on a.ts:3 (a reply)",
      "  gh api repos/octo/widgets/pulls/comments/6 --jq .body",
    ]);
    // Filtering on review.* leaves the reply out, so its review shows.
    reply();
    run = cli(["wait", "--settle", "0", "--kinds", "review.*"]);
    expect(await run.code).toBe(0);
    expect(run.stdout().split("\n").slice(0, 3)).toEqual([
      "octo/widgets#7: 1 new event",
      "- review.submitted: commented",
      "  gh api repos/octo/widgets/pulls/7/reviews/5 --jq '.state, .body'",
    ]);
  });

  it("subscribes its targets on the server, and stops watching when the server ends the watch", async () => {
    fake.repos.set("octo/widgets", { private: false });
    // The server's first subscription will be sub_1.
    fake.inject("box", "pr.merged", {}, "e1", "sub_1");
    fake.inject("box", "watch.ended", { reason: "merged" }, "e2", "sub_1");
    const run = cli(["wait", "octo/widgets#7", "--settle", "0", "--format", "json"]);
    // 3: everything watched has ended.
    expect(await run.code, run.stderr()).toBe(3);
    expect(fake.subscriptions).toEqual([{ id: "sub_1", inbox: "box", repo: "octo/widgets", pr: 7, githubToken: null }]);
    expect(run.stderr()).toBe("watcheroni: watching octo/widgets#7 in inbox box\n");
    const out = JSON.parse(run.stdout()) as { events: { kind: string }[]; watching: string[] };
    expect(out.events.map((e) => e.kind)).toEqual(["pr.merged", "watch.ended"]);
    expect(out.watching).toEqual([]);
  });

  it("polls a target from this machine when the App isn't installed on its repo", async () => {
    const run = cli(["wait", "octo/widgets#7"], { GH_TOKEN: "x" });
    await until(() => run.stderr().includes("polling GitHub"));
    run.kill();
    await run.code;
    expect(run.stderr()).toMatch(/the watcheroni App isn't installed on octo\/widgets; it can be installed from https:\/\/github.com\/apps\/watcheroni\/installations\/new\nwatcheroni: watching octo\/widgets#7 in inbox box, polling GitHub from this machine/);
  });

  it("offers a PR named again to the server at once, e.g. after the App is installed", async () => {
    const first = cli(["wait", "octo/widgets#7"], { GH_TOKEN: "x" });
    await until(() => first.stderr().includes("polling GitHub"));
    first.kill();
    await first.code;
    expect(fake.subscriptions).toEqual([]);
    fake.repos.set("octo/widgets", { private: false });
    const second = cli(["wait", "octo/widgets#7", "--timeout", "1s"], { GH_TOKEN: "x" });
    expect(await second.code, second.stderr()).toBe(2);
    expect(fake.subscriptions.map((s) => s.repo)).toEqual(["octo/widgets"]);
  });

  it("times out with exit code 2", async () => {
    const run = cli(["wait", "--timeout", "1s"]);
    expect(await run.code).toBe(2);
    expect(run.stdout()).toBe("No new events. Still reading inbox box. Run `watcheroni wait` again to keep watching.\n");
  });

  it("exits 4 when the key is wrong or missing", async () => {
    const wrong = cli(["wait"], { WATCHERONI_API_KEY: "nope" });
    expect(await wrong.code).toBe(4);
    expect(wrong.stderr()).toMatch(/rejected the API key/);
    const missing = cli(["wait"], { WATCHERONI_API_KEY: "" });
    expect(await missing.code).toBe(4);
    expect(missing.stderr()).toMatch(/No API key for/);
  });

  it("takes the server and key from the config files", async () => {
    const dir = join(cwd, "config");
    mkdirSync(dir);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ server: `${fake.url}/` }));
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ servers: { [fake.url]: { api_key: fake.token } } }));
    fake.inject("box", "comment.created");
    const run = cli(["wait", "--settle", "0"], { WATCHERONI_SERVER: null, WATCHERONI_API_KEY: null });
    expect(await run.code).toBe(0);
    expect(fake.inbox("box").acked).toBe(1);
  });

  it("says when the server is unreachable and there's nothing to poll instead", async () => {
    const url = fake.url;
    await fake.stop();
    const run = cli(["wait"], { WATCHERONI_SERVER: url });
    expect(await run.code).toBe(1);
    expect(run.stderr()).toMatch(/can't reach .*; polling GitHub from this machine instead/);
    expect(run.stderr()).toMatch(/inbox box watches no PR to poll from here instead/);
  });

  it("runs as before with no server", async () => {
    const run = cli(["wait"], { WATCHERONI_SERVER: "" });
    expect(await run.code).toBe(1);
    expect(run.stderr()).toBe("watcheroni: Not on a git branch; name a PR (owner/repo#123)\n");
    expect(fake.requests).toEqual([]);
  });
});

describe("stream against a server", () => {
  it("prints each event as a JSON line and acknowledges it", async () => {
    fake.inject("box", "comment.created");
    const run = cli(["stream"]);
    await until(() => run.stdout().split("\n").length === 2);
    fake.inject("box", "review.submitted");
    await until(() => run.stdout().split("\n").length === 3);
    await until(() => fake.inbox("box").acked === 2);
    run.kill();
    await run.code;
    expect(run.stdout().trim().split("\n").map((l) => (JSON.parse(l) as { kind: string }).kind)).toEqual(["comment.created", "review.submitted"]);
  });
});

describe("exec against a server", () => {
  it("acknowledges an event only when the command succeeds", async () => {
    const log = join(cwd, "ran");
    fake.inject("box", "comment.created");
    fake.inject("box", "check.failed");
    // Succeeds for comments, fails for checks.
    const script = `echo "$WATCHERONI_KIND" >> ${log}; [ "$WATCHERONI_KIND" = comment.created ]`;
    const run = cli(["exec", "--", "sh", "-c", script]);
    await until(() => run.stderr().includes("command exited 1 for check.failed"));
    expect(fake.inbox("box").acked).toBe(1);
    run.kill();
    await run.code;
    expect(readFileSync(log, "utf8")).toBe("comment.created\ncheck.failed\n");
  });
});

describe("reading with no server", () => {
  // As `watcheroni watch` leaves an inbox for a PR that had already ended.
  function leaveWatchEnded(): void {
    process.env.WATCHERONI_STATE_DIR = env.WATCHERONI_STATE_DIR;
    const inbox = Inbox.open("box");
    inbox.append([{
      v: 1, id: "local:octo/widgets#7:watch.ended:merged", sub: null, kind: "watch.ended", at: "t", received_at: "t",
      repo: { id: 1, full_name: "octo/widgets" }, pr: 7, actor: null, data: { reason: "merged" }, links: {},
    }]);
    inbox.close();
  }

  it("runs the command for events left in an inbox that watches nothing, then exits 3", async () => {
    leaveWatchEnded();
    const run = cli(["exec", "--", "sh", "-c", 'echo "$WATCHERONI_KIND $WATCHERONI_REPO#$WATCHERONI_PR"'], { WATCHERONI_SERVER: "" });
    expect(await run.code).toBe(3);
    expect(run.stdout()).toBe("watch.ended octo/widgets#7\n");
    expect(run.stderr()).toBe("watcheroni: Not on a git branch; name a PR (owner/repo#123); reading the events left in inbox box\n");
    expect(Inbox.peek("box").pending).toBe(0);
  });

  it("still needs a PR to watch, whatever the inbox holds", async () => {
    leaveWatchEnded();
    const run = cli(["watch"], { WATCHERONI_SERVER: "" });
    expect(await run.code).toBe(1);
    expect(run.stderr()).toBe("watcheroni: Not on a git branch; name a PR (owner/repo#123)\n");
    expect(Inbox.peek("box").pending).toBe(1);
  });
});
