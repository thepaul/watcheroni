import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
      "  gh api repos/octo/widgets/pulls/7/reviews/5",
      "- comment.created",
      "  gh api repos/octo/widgets/issues/comments/9",
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
