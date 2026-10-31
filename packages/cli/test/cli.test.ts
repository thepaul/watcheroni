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
function cli(args: string[], extraEnv: Record<string, string | null> = {}, dir = cwd): Run {
  const merged = Object.entries({ ...env, ...extraEnv }).filter((kv): kv is [string, string] => kv[1] !== null);
  const child = spawn(process.execPath, [MAIN, ...args], { cwd: dir, env: Object.fromEntries(merged) });
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
    fake.inject("box", "check.completed");
    expect(await run.code).toBe(0);
    const out = JSON.parse(run.stdout()) as { events: { kind: string }[]; watching: string[] };
    expect(out.events.map((e) => e.kind)).toEqual(["check.failed", "check.completed"]);
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

  it("shows a reply and the review GitHub makes for it", async () => {
    fake.inject("box", "review.submitted", { review_id: 5, state: "commented", has_body: false });
    fake.inject("box", "review_comment.created", { comment_id: 6, review_id: 5, path: "a.ts", line: 3, in_reply_to: 4 });
    const run = cli(["wait", "--settle", "0"]);
    expect(await run.code).toBe(0);
    expect(run.stdout().split("\n").slice(0, 5)).toEqual([
      "octo/widgets#7: 2 new events",
      "- review.submitted: commented",
      "  gh api repos/octo/widgets/pulls/7/reviews/5 --jq '.state, .body'",
      "- review_comment.created on a.ts:3 (a reply)",
      "  gh api repos/octo/widgets/pulls/comments/6 --jq .body",
    ]);
  });

  it("with --settle 0, prints what one read brought as soon as it arrives", async () => {
    // A lone comment: printed at once, not after the default 5 s.
    let run = cli(["wait", "--settle", "0", "--format", "json"]);
    await until(() => fake.sockets.size === 1);
    const sent = Date.now();
    fake.inject("box", "comment.created");
    expect(await run.code).toBe(0);
    expect(Date.now() - sent).toBeLessThan(3000);
    expect((JSON.parse(run.stdout()) as { events: { kind: string }[] }).events.map((e) => e.kind)).toEqual(["comment.created"]);
    // Events that come in one read are printed together.
    await until(() => fake.sockets.size === 0);
    run = cli(["wait", "--settle", "0", "--format", "json"]);
    await until(() => fake.sockets.size === 1);
    fake.injectTogether("box", ["review.submitted", { review_id: 5 }], ["review_comment.created", { comment_id: 6, review_id: 5 }]);
    expect(await run.code).toBe(0);
    expect((JSON.parse(run.stdout()) as { events: { kind: string }[] }).events.map((e) => e.kind)).toEqual(["review.submitted", "review_comment.created"]);
    expect(fake.inbox("box").acked).toBe(3);
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

  it("won't send the API key over plain http to another machine", async () => {
    const run = cli(["wait"], { WATCHERONI_SERVER: "http://watcheroni.dev" });
    expect(await run.code).toBe(1);
    expect(run.stderr()).toBe("watcheroni: http://watcheroni.dev: the server must be https; plain http is only for localhost, 127.0.0.0/8 or [::1]\n");
  });

  it("runs as before with no server", async () => {
    const run = cli(["wait"], { WATCHERONI_SERVER: "" });
    expect(await run.code).toBe(1);
    expect(run.stderr()).toBe("watcheroni: Not on a git branch; name a PR (owner/repo#123)\n");
    expect(fake.requests).toEqual([]);
  });
});

describe("watching a whole repository", () => {
  it("subscribes with its filters, wakes on a matching event, and never says it ended", async () => {
    fake.repos.set("octo/widgets", { private: false });
    const run = cli(["wait", "octo/widgets", "--kinds", "pr.opened", "--base", "main", "--settle", "0"]);
    await until(() => fake.sockets.size === 1);
    expect(fake.subscriptions).toEqual([{ id: "sub_1", inbox: "box", repo: "octo/widgets", pr: null, githubToken: null, kinds: ["pr.opened"], base: "main" }]);
    fake.inject("box", "pr.opened", { head_sha: "4f2e1a9", base: "main", draft: false }, "e1", "sub_1", 12);
    expect(await run.code, run.stderr()).toBe(0);
    expect(run.stderr()).toBe("watcheroni: watching octo/widgets (pr.opened; base main) in inbox box\n");
    expect(run.stdout()).toBe([
      "octo/widgets#12: 1 new event",
      "- pr.opened",
      "",
      "Still watching octo/widgets (pr.opened; base main). Run `watcheroni wait` again to keep watching.",
      "",
    ].join("\n"));

    // Next time it's known, so not subscribed again; with nothing new, a timeout.
    const again = cli(["wait", "octo/widgets", "--kinds", "pr.opened", "--base", "main", "--timeout", "1s"]);
    expect(await again.code).toBe(2);
    expect(fake.subscriptions).toHaveLength(1);
    const ls = cli(["ls"]);
    expect(await ls.code).toBe(0);
    expect(ls.stdout()).toMatch(/^octo\/widgets \(pr\.opened; base main\)  since /);
  });

  it("keeps waiting after the PRs watched beside it have ended", async () => {
    fake.repos.set("octo/widgets", { private: false });
    // The repository is subscribed first, as sub_1; the PR is sub_2.
    fake.inject("box", "pr.merged", {}, "e1", "sub_2");
    fake.inject("box", "watch.ended", { reason: "merged" }, "e2", "sub_2");
    const run = cli(["wait", "octo/widgets#7", "octo/widgets", "--kinds", "pr.*", "--author", "paul", "--settle", "0", "--format", "json"]);
    expect(await run.code, run.stderr()).toBe(0);
    expect(fake.subscriptions.map((s) => [s.pr, s.author ?? null])).toEqual([[null, "paul"], [7, null]]);
    expect((JSON.parse(run.stdout()) as { watching: string[] }).watching).toEqual(["octo/widgets (pr.*; author paul)"]);
  });

  it("stops watching when the server ends the subscription", async () => {
    fake.repos.set("octo/widgets", { private: false });
    fake.inject("box", "watch.revoked", { reason: "uninstalled" }, "e1", "sub_1", null);
    const run = cli(["wait", "octo/widgets", "--kinds", "pr.opened", "--settle", "0"]);
    expect(await run.code, run.stderr()).toBe(3);
    expect(run.stdout()).toMatch(/^octo\/widgets: 1 new event\n- watch.revoked/);
    expect(run.stdout()).toMatch(/Nothing is left to watch: the server's watch on the repository has ended.\n$/);
    const ls = cli(["ls"]);
    await ls.code;
    expect(ls.stdout()).toBe("Inbox box is watching nothing.\n");
  });

  it("unwatches on the server", async () => {
    fake.repos.set("octo/widgets", { private: false });
    expect(await cli(["watch", "octo/widgets", "--kinds", "pr.opened"]).code).toBe(0);
    expect(await cli(["watch", "octo/widgets", "--kinds", "check.failed", "--author", "paul"]).code).toBe(0);
    const run = cli(["unwatch", "octo/widgets"]);
    expect(await run.code, run.stderr()).toBe(0);
    expect(fake.deleted).toEqual(["sub_1", "sub_2"]);
    // Without a server, it says the server's subscription is left.
    expect(await cli(["watch", "octo/widgets", "--kinds", "pr.opened"]).code).toBe(0);
    const offline = cli(["unwatch", "octo/widgets"], { WATCHERONI_SERVER: "" });
    expect(await offline.code).toBe(0);
    expect(offline.stderr()).toMatch(/stopped watching octo\/widgets \(pr.opened\) here, but with no server configured its subscription there wasn't ended/);
    expect(fake.deleted).toEqual(["sub_1", "sub_2"]);
    const ls = cli(["ls"]);
    await ls.code;
    expect(ls.stdout()).toBe("Inbox box is watching nothing.\n");
  });

  it("explains what it needs", async () => {
    const noKinds = cli(["wait", "octo/widgets"]);
    expect(await noKinds.code).toBe(1);
    expect(noKinds.stderr()).toMatch(/needs --kinds/);
    const noServer = cli(["wait", "octo/widgets", "--kinds", "pr.opened"], { WATCHERONI_SERVER: "" });
    expect(await noServer.code).toBe(1);
    expect(noServer.stderr()).toMatch(/needs the watcheroni server.*polling every PR in it/);
    const stray = cli(["wait", "octo/widgets#7", "--base", "main"]);
    expect(await stray.code).toBe(1);
    expect(stray.stderr()).toMatch(/--base and --author are for whole-repository targets/);
    // Not installed: there's no polling to fall back on.
    const refused = cli(["wait", "octo/widgets", "--kinds", "pr.opened"]);
    expect(await refused.code).toBe(1);
    expect(refused.stderr()).toMatch(/App isn't installed on octo\/widgets.*\n.*can't watch octo\/widgets \(pr.opened\)/);
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

  it("with --batch --settle 0, runs once per read", async () => {
    const log = join(cwd, "ran");
    const run = cli(["exec", "--batch", "--settle", "0", "--", "sh", "-c", `echo "$WATCHERONI_COUNT" >> ${log}`]);
    await until(() => fake.sockets.size === 1);
    const sent = Date.now();
    fake.injectTogether("box", ["review.submitted"], ["review_comment.created"]);
    await until(() => fake.inbox("box").acked === 2);
    expect(Date.now() - sent).toBeLessThan(3000);
    fake.inject("box", "comment.created");
    await until(() => fake.inbox("box").acked === 3);
    run.kill();
    await run.code;
    expect(readFileSync(log, "utf8")).toBe("2\n1\n");
  });
});

describe("selfhost", () => {
  it("runs the clone's script with the arguments it was given", async () => {
    const run = cli(["selfhost", "--help"], {}, join(import.meta.dirname, "..", "..", "server"));
    expect(await run.code).toBe(0);
    expect(run.stdout()).toContain("watcheroni selfhost [options]");
  });

  it("says to clone the repository when run elsewhere", async () => {
    const run = cli(["selfhost"]);
    expect(await run.code).toBe(1);
    expect(run.stderr()).toContain("git clone https://github.com/thepaul/watcheroni");
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

  it("doesn't wait on a repository-wide watch, which only a server feeds", async () => {
    leaveWatchEnded();
    const inbox = Inbox.open("box");
    inbox.watchRepo("octo/widgets (pr.opened)", { owner: "octo", name: "widgets", kinds: ["pr.opened"] }, "sub_1");
    inbox.close();
    const run = cli(["exec", "--", "sh", "-c", 'echo "$WATCHERONI_KIND"'], { WATCHERONI_SERVER: "" });
    expect(await run.code).toBe(3);
    expect(run.stdout()).toBe("watch.ended\n");
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

describe("ls --all", () => {
  it("lists every inbox here, with what it watches and the events waiting", async () => {
    process.env.WATCHERONI_STATE_DIR = env.WATCHERONI_STATE_DIR;
    const box = Inbox.open("box");
    box.watch("octo/widgets#7", { owner: "octo", name: "widgets", number: 7 });
    box.append([{
      v: 1, id: "e1", sub: null, kind: "pr.opened", at: "t", received_at: "t",
      repo: { id: 1, full_name: "octo/widgets" }, pr: 7, actor: null, data: {}, links: {},
    }]);
    box.close();
    // A file is written once something changes: here, a watch since ended.
    const empty = Inbox.open("cc-abc");
    empty.watch("octo/widgets#8", { owner: "octo", name: "widgets", number: 8 });
    empty.unwatch("octo/widgets#8");
    empty.close();
    const run = cli(["ls", "--all"], { WATCHERONI_SERVER: "" });
    expect(await run.code).toBe(0);
    expect(run.stdout()).toMatch(/^box:\n  octo\/widgets#7  since \S+\n  1 event\(s\) not yet read\.\ncc-abc:\n  watching nothing\.\n$/);
  });

  it("says so when there are none", async () => {
    const run = cli(["ls", "--all"], { WATCHERONI_SERVER: "" });
    expect(await run.code).toBe(0);
    expect(run.stdout()).toBe("No inboxes on this machine.\n");
  });
});
