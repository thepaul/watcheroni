import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

  it("with --json, prints each event as a JSON line, then how it ended", async () => {
    fake.inject("box", "review.submitted", { review_id: 5, state: "approved" });
    fake.inject("box", "comment.created", { comment_id: 9 });
    const run = cli(["wait", "--settle", "0", "--json"]);
    expect(await run.code).toBe(0);
    const lines = run.stdout().trimEnd().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l.kind ?? l.result)).toEqual(["review.submitted", "comment.created", "events"]);
    expect(lines.map((l) => l.command)).toEqual([
      "gh api repos/octo/widgets/pulls/7/reviews/5 --jq '.state, .body'",
      "gh api repos/octo/widgets/issues/comments/9 --jq .body",
      undefined,
    ]);
    expect(lines[2]).toEqual({ result: "events", watching: [] });
    expect(fake.inbox("box").acked).toBe(2);
  });

  it("with --json, gives each of a review's comments its own command", async () => {
    fake.inject("box", "review_comment.created", { comment_id: 6, review_id: 5, path: "a.ts", line: 3 });
    fake.inject("box", "review_comment.created", { comment_id: 8, review_id: 5, path: "b.ts" });
    const run = cli(["wait", "--settle", "0", "--json"]);
    expect(await run.code).toBe(0);
    expect(run.stdout().trimEnd().split("\n").slice(0, 2).map((l) => (JSON.parse(l) as { command: string }).command)).toEqual([
      "gh api repos/octo/widgets/pulls/comments/6 --jq .body",
      "gh api repos/octo/widgets/pulls/comments/8 --jq .body",
    ]);
  });

  it("with --json, says so on a line of its own when it times out", async () => {
    const run = cli(["wait", "--timeout", "1s", "--json"]);
    expect(await run.code).toBe(2);
    expect(run.stdout()).toBe(`${JSON.stringify({ result: "timeout", watching: [] })}\n`);
  });

  it("won't take --json and --format together, or --json where it means nothing", async () => {
    const both = cli(["wait", "--json", "--format", "json"]);
    expect(await both.code).toBe(1);
    expect(both.stderr()).toBe("watcheroni: --json replaces --format; use one or the other\n");
    const exec = cli(["exec", "--json", "--", "true"]);
    expect(await exec.code).toBe(1);
    expect(exec.stderr()).toBe("watcheroni: exec has no --json; wait, stream and ls do\n");
    const logout = cli(["logout", "--json"]);
    expect(await logout.code).toBe(1);
    expect(logout.stderr()).toBe("watcheroni: logout has no --json; wait, stream and ls do\n");
  });

  it("filters kinds, acknowledging the ones skipped", async () => {
    fake.inject("box", "comment.created");
    fake.inject("box", "check.failed");
    const run = cli(["wait", "--settle", "0", "--kinds", "check.*", "--format", "json"]);
    expect(await run.code).toBe(0);
    expect((JSON.parse(run.stdout()) as { events: { seq: number }[] }).events.map((e) => e.seq)).toEqual([2]);
    expect(fake.inbox("box").acked).toBe(2);
  });

  it("prints repo.* whatever --kinds says", async () => {
    fake.inject("box", "comment.created");
    fake.inject("box", "repo.throttled", { until: "2026-10-26T18:00:00Z" }, "e2", null, null);
    fake.inject("box", "repo.unthrottled", { dropped: 3 }, "e3", null, null);
    const run = cli(["wait", "--settle", "0", "--kinds", "check.*", "--format", "json"]);
    expect(await run.code).toBe(0);
    expect((JSON.parse(run.stdout()) as { events: { kind: string }[] }).events.map((e) => e.kind)).toEqual(["repo.throttled", "repo.unthrottled"]);
  });

  it("wakes on inbox.gap whatever --kinds says, and says what to do", async () => {
    fake.repos.set("octo/widgets", { private: false });
    const run = cli(["wait", "octo/widgets#7", "--settle", "0", "--kinds", "check.*"]);
    await until(() => fake.sockets.size === 1);
    fake.gap("box", 0, 41);
    expect(await run.code, run.stderr()).toBe(0);
    expect(run.stdout()).toBe([
      "inbox: 1 new event",
      "- inbox.gap: 40 events were dropped before they were read; check the watched PRs on GitHub",
      "",
      "octo/widgets#7 is still open. Run `watcheroni wait` again to keep watching.",
      "",
    ].join("\n"));
    expect(fake.inbox("box").acked).toBe(40);
  });

  it("prints inbox.gap with --format json", async () => {
    const run = cli(["wait", "--settle", "0", "--format", "json"]);
    await until(() => fake.sockets.size === 1);
    fake.gap("box", 3, 10);
    expect(await run.code, run.stderr()).toBe(0);
    const out = JSON.parse(run.stdout()) as { events: { seq: number; kind: string; repo: unknown; data: unknown }[] };
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toMatchObject({ seq: 9, kind: "inbox.gap", repo: null, data: { missed_after: 3, resumed_at: 10 } });
    expect(fake.inbox("box").acked).toBe(9);
  });

  // Runs the CLI 13 times, two of them waiting 1 s: too close to the
  // default 5 s timeout on a busy machine.
  it("remembers --kinds given with a PR, until it's changed", async () => {
    fake.repos.set("octo/widgets", { private: false });
    fake.inject("box", "comment.created");
    fake.inject("box", "check.failed");
    const run = cli(["wait", "octo/widgets#7", "--settle", "0", "--kinds", "check.*", "--format", "json"]);
    expect(await run.code, run.stderr()).toBe(0);
    expect(run.stderr()).toBe("watcheroni: watching octo/widgets#7 in inbox box for check.*\n");
    expect((JSON.parse(run.stdout()) as { events: { kind: string }[] }).events.map((e) => e.kind)).toEqual(["check.failed"]);
    const kindsNow = async () => {
      const ls = cli(["ls", "--json"]);
      expect(await ls.code).toBe(0);
      return (JSON.parse(ls.stdout()) as { prs: { kinds?: string[] }[] }).prs[0]!.kinds;
    };
    expect(await kindsNow()).toEqual(["check.*"]);
    const ls = cli(["ls"]);
    expect(await ls.code).toBe(0);
    expect(ls.stdout()).toMatch(/^octo\/widgets#7 \(check\.\*\)  since /);

    // Naming the PR again without --kinds keeps them.
    fake.inject("box", "comment.created");
    const again = cli(["wait", "octo/widgets#7", "--settle", "0", "--timeout", "1s", "--format", "json"]);
    expect(await again.code, again.stderr()).toBe(2);
    expect(await kindsNow()).toEqual(["check.*"]);

    // --kinds with no PR named narrows that run, on top of the PR's own,
    // and isn't saved.
    fake.inject("box", "check.failed");
    const narrowed = cli(["wait", "--settle", "0", "--timeout", "1s", "--kinds", "comment.created", "--format", "json"]);
    expect(await narrowed.code, narrowed.stderr()).toBe(2);
    expect(await kindsNow()).toEqual(["check.*"]);

    const reset = cli(["watch", "octo/widgets#7", "--kinds", "*"]);
    expect(await reset.code, reset.stderr()).toBe(0);
    expect(reset.stderr()).toBe("watcheroni: watching octo/widgets#7 for every kind\n");
    expect(await kindsNow()).toBeUndefined();

    // Unwatching forgets them.
    expect(await cli(["watch", "octo/widgets#7", "--kinds", "check.*"]).code).toBe(0);
    expect(await cli(["unwatch", "octo/widgets#7"]).code).toBe(0);
    expect(await cli(["watch", "octo/widgets#7"]).code).toBe(0);
    expect(await kindsNow()).toBeUndefined();
  }, 15_000);

  it("lets watch and unwatch change the inbox while it waits", async () => {
    fake.repos.set("octo/widgets", { private: false });
    const run = cli(["wait", "octo/widgets#7", "--settle", "0", "--timeout", "20s", "--json"]);
    await until(() => run.stderr().includes("watching octo/widgets#7"));
    const watch = cli(["watch", "octo/widgets#8"]);
    expect(await watch.code, watch.stderr()).toBe(0);
    expect(watch.stderr()).toBe("watcheroni: watching octo/widgets#8 in inbox box\n");
    const unwatch = cli(["unwatch", "octo/widgets#7"]);
    expect(await unwatch.code, unwatch.stderr()).toBe(0);
    expect(fake.deleted).toEqual(["sub_1"]);
    // #7's subscription had this queued; #8's is reported.
    fake.inject("box", "comment.created", {}, "e1", "sub_1", 7);
    fake.inject("box", "comment.created", {}, "e2", "sub_2", 8);
    expect(await run.code, run.stderr()).toBe(0);
    const lines = run.stdout().trimEnd().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l.id ?? l.result)).toEqual(["e2", "events"]);
    expect(lines.at(-1)).toEqual({ result: "events", watching: ["octo/widgets#8"] });
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
    const run = cli(["wait", "octo/widgets#7", "--settle", "0", "--json"]);
    // 3: everything watched has ended.
    expect(await run.code, run.stderr()).toBe(3);
    expect(fake.subscriptions).toEqual([{ id: "sub_1", inbox: "box", repo: "octo/widgets", pr: 7, githubToken: null }]);
    expect(run.stderr()).toBe("watcheroni: watching octo/widgets#7 in inbox box\n");
    const lines = run.stdout().trimEnd().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l.kind ?? l.result)).toEqual(["pr.merged", "watch.ended", "ended"]);
    expect(lines[2]).toEqual({ result: "ended", watching: [] });
  });

  it("polls a target from this machine when the App isn't installed on its repo", async () => {
    const run = cli(["wait", "octo/widgets#7"], { GH_TOKEN: "x" });
    await until(() => run.stderr().includes("polling GitHub"));
    expect(existsSync(join(env.WATCHERONI_STATE_DIR, "inboxes", "box.lock"))).toBe(true);
    run.kill();
    await run.code;
    // Let go when killed.
    expect(existsSync(join(env.WATCHERONI_STATE_DIR, "inboxes", "box.lock"))).toBe(false);
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

  it("deletes inboxes unused here for a week, on the server too", async () => {
    process.env.WATCHERONI_STATE_DIR = env.WATCHERONI_STATE_DIR;
    const old = Inbox.edit("old");
    old.append([]);
    const t = new Date(Date.now() - 8 * 24 * 3600_000);
    utimesSync(join(env.WATCHERONI_STATE_DIR, "inboxes", "old.json"), t, t);
    Object.assign(fake.inbox("old"), { createdAt: t.toISOString(), lastReadAt: t.toISOString() });
    fake.inject("box", "comment.created", { comment_id: 9 });
    const run = cli(["wait", "--settle", "0"]);
    expect(await run.code).toBe(0);
    expect(fake.deletedInboxes).toEqual(["old"]);
    expect(Inbox.names()).not.toContain("old");
    expect(run.stderr()).toBe("");
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
    expect(await again.code, again.stderr()).toBe(2);
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
    const events = run.stdout().trim().split("\n").map((l) => JSON.parse(l) as { kind: string });
    expect(events.map((e) => e.kind)).toEqual(["comment.created", "review.submitted"]);
    // Only --json adds the command.
    expect(events[0]).not.toHaveProperty("command");
  });

  it("with --json, adds the command that fetches each event's content", async () => {
    fake.inject("box", "comment.created", { comment_id: 9 });
    fake.inject("box", "pr.pushed");
    const run = cli(["stream", "--json"]);
    await until(() => fake.inbox("box").acked === 2);
    run.kill();
    await run.code;
    expect(run.stdout().trim().split("\n").map((l) => JSON.parse(l) as { kind: string; command: string | null }).map((e) => [e.kind, e.command])).toEqual([
      ["comment.created", "gh api repos/octo/widgets/issues/comments/9 --jq .body"],
      ["pr.pushed", null],
    ]);
  });
});

describe("exec against a server", () => {
  it("remembers --on given with a PR as its kinds", async () => {
    fake.repos.set("octo/widgets", { private: false });
    const log = join(cwd, "ran");
    fake.inject("box", "comment.created");
    fake.inject("box", "check.failed");
    const run = cli(["exec", "octo/widgets#7", "--on", "check.failed", "--", "sh", "-c", `echo "$WATCHERONI_KIND" >> ${log}`]);
    await until(() => fake.inbox("box").acked === 2);
    run.kill();
    await run.code;
    expect(readFileSync(log, "utf8")).toBe("check.failed\n");
    const ls = cli(["ls", "--json"]);
    expect(await ls.code).toBe(0);
    expect((JSON.parse(ls.stdout()) as { prs: { kinds?: string[] }[] }).prs.map((p) => p.kinds)).toEqual([["check.failed"]]);
  });

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

  it("keeps listing past an inbox file it can't read, then exits 1", async () => {
    const dir = join(env.WATCHERONI_STATE_DIR, "inboxes");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a-bad.json"), "null");
    writeFileSync(join(dir, "b-good.json"), JSON.stringify({
      version: 1, seq: 0, acked: 0, events: [], seen: [],
      watched: { "octo/widgets#7": { target: { owner: "octo", name: "widgets", number: 7 }, addedAt: "t", snapshot: null } },
    }));
    const run = cli(["ls", "--all"], { WATCHERONI_SERVER: "" });
    expect(await run.code).toBe(1);
    expect(run.stdout()).toMatch(/^a-bad:\n  can't be read: .+\nb-good:\n  octo\/widgets#7  since t\n$/);
  });

  it("says so when there are none", async () => {
    const run = cli(["ls", "--all"], { WATCHERONI_SERVER: "" });
    expect(await run.code).toBe(0);
    expect(run.stdout()).toBe("No inboxes on this machine.\n");
  });

  it("with --json, prints an array of inboxes, with an error for one it can't read", async () => {
    const dir = join(env.WATCHERONI_STATE_DIR, "inboxes");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a-bad.json"), "null");
    writeFileSync(join(dir, "b-good.json"), JSON.stringify({
      version: 1, seq: 0, acked: 0, events: [], seen: [],
      watched: { "octo/widgets#7": { target: { owner: "octo", name: "widgets", number: 7 }, addedAt: "t", snapshot: null } },
      repos: { "octo/widgets (pr.opened; base main)": { target: { owner: "octo", name: "widgets", kinds: ["pr.opened"], base: "main" }, addedAt: "u", sub: "sub_1" } },
    }));
    const run = cli(["ls", "--all", "--json"], { WATCHERONI_SERVER: "" });
    expect(await run.code).toBe(1);
    const out = JSON.parse(run.stdout()) as Record<string, unknown>[];
    expect(out[0]).toMatchObject({ inbox: "a-bad", error: expect.any(String) });
    expect(out[1]).toEqual({
      inbox: "b-good",
      prs: [{ pr: "octo/widgets#7", since: "t" }],
      repos: [{ repo: "octo/widgets", kinds: ["pr.opened"], base: "main", since: "u" }],
      pending: 0,
    });
  });

  it("with --json and no inboxes, prints an empty array", async () => {
    const run = cli(["ls", "--all", "--json"], { WATCHERONI_SERVER: "" });
    expect(await run.code).toBe(0);
    expect(run.stdout()).toBe("[]\n");
  });
});

describe("what the server says", () => {
  const NASTY = "\x1b[31mred\x1b]8;;https://evil.test\x07link\x1b]8;;\x07\rover\u009b2J\x00end";
  // Anything but the line breaks between lines.
  const CONTROLS = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;

  it("never reaches the terminal raw", async () => {
    fake.problem = { status: 422, body: { status: 422, code: "nope", title: NASTY, detail: NASTY } };
    const refused = cli(["wait", "--settle", "0"]);
    expect(await refused.code).toBe(1);
    expect(refused.stderr()).toMatch(/: 422 \[31mred .* end\n$/);
    expect(refused.stderr()).not.toMatch(CONTROLS);

    // An answer that isn't JSON is taken as no answer, and not quoted.
    fake.problem = { status: 200, body: `${NASTY}{` };
    const garbled = cli(["wait", "--settle", "0"]);
    await until(() => /isn't JSON/.test(garbled.stderr()));
    garbled.kill();
    await garbled.code;
    expect(garbled.stderr()).toMatch(/^watcheroni: \S+ sent an answer to PUT \/v1\/inboxes\/box that isn't JSON; polling GitHub from this machine instead\n/);
    expect(garbled.stderr()).not.toMatch(CONTROLS);
  });

  it("never reaches the terminal raw from GitHub's GraphQL errors, polling from this machine", async () => {
    // GitHub, answering every request with `body`, in the CLI's process.
    // The body goes in base64, as the environment can't hold a NUL.
    const preload = join(cwd, "github.mjs");
    writeFileSync(preload, [
      "const real = globalThis.fetch;",
      "globalThis.fetch = async (input, init) => {",
      "  const url = String(input instanceof Request ? input.url : input);",
      "  if (!url.startsWith('https://api.github.com/')) return real(input, init);",
      "  return new Response(Buffer.from(process.env.FAKE_GITHUB_BODY, 'base64'), { status: Number(process.env.FAKE_GITHUB_STATUS), headers: { 'content-type': 'application/json' } });",
      "};",
    ].join("\n"));
    // Formatting characters too, as in `hostile` (below).
    const nasty = hostile;
    for (const [status, body] of [[200, JSON.stringify({ errors: [{ message: nasty }] })], [502, nasty]] as const) {
      const run = cli(["wait", "octo/widgets#7", "--timeout", "1s"], {
        WATCHERONI_SERVER: null, WATCHERONI_API_KEY: null, GH_TOKEN: "x",
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, FAKE_GITHUB_STATUS: String(status), FAKE_GITHUB_BODY: Buffer.from(body).toString("base64"),
      });
      expect(await run.code, run.stderr()).toBe(2);
      expect(run.stderr()).toMatch(/^watcheroni: octo\/widgets#7: .*\[31mred.*end ?; trying again next time$/m);
      expect(run.stderr()).not.toMatch(RAW);
    }
  });

  // Anything but line breaks, as CONTROLS, and formatting characters too.
  const RAW = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;
  const hostile = `${NASTY}\u200b\u2028\u202e\ufeff\u200c\u202a\u2066\u061c\u180e`;
  // JSON output carries `hostile` escaped, not lost.
  const escaped = (out: string) => {
    expect(out).not.toMatch(RAW);
    expect(out).toContain(String.raw`\u001b[31mred`);
    expect(out).toContain(String.raw`\u009b2J\u0000end\u200b\u2028\u202e\ufeff\u200c\u202a\u2066\u061c\u180e`);
  };
  const injectHostile = (id: string, pr = 7) => fake.inject("box", hostile, { state: hostile, path: hostile, name: hostile }, id, null, pr);

  it("never reaches stdout raw from an event, as text or JSON", async () => {
    // A PR number that isn't a whole number is shown as "?".
    injectHostile(hostile, 7.5);
    const text = cli(["wait", "--settle", "0"]);
    expect(await text.code).toBe(0);
    expect(text.stdout()).toMatch(/^octo\/widgets#\?: 1 new event\n/);
    expect(text.stdout()).not.toMatch(RAW);

    for (const args of [["wait", "--settle", "0", "--json"], ["wait", "--settle", "0", "--format", "json"]]) {
      injectHostile(`${hostile}${args.length}`);
      const json = cli(args);
      expect(await json.code).toBe(0);
      escaped(json.stdout());
      const first = JSON.parse(json.stdout().split("\n")[0]) as { kind?: string; events?: { kind: string }[] };
      expect(first.kind ?? first.events![0].kind).toBe(hostile);
    }
  });

  it("can't break wait with a malformed event", async () => {
    fake.injectMalformed("box", { kind: 42, data: null });
    fake.inject("box", "comment.created", { comment_id: 9 });
    const run = cli(["wait", "--settle", "0", "--kinds", "comment.created"]);
    expect(await run.code).toBe(0);
    expect(run.stdout()).toMatch(/^octo\/widgets#7: 1 new event\n- comment.created\n/);
    expect(run.stderr()).toMatch(
      /^watcheroni: dropped a malformed event from \S+ \(octo\/widgets#7, seq 1, id "fake:[^"]*"\): it isn't shaped as the protocol says, so it's acknowledged unshown; if this keeps happening, report it to the server's operator\n$/,
    );
    expect(fake.inbox("box").acked).toBe(2);
  });

  it("never reaches stdout raw from stream --json", async () => {
    injectHostile("e1");
    const run = cli(["stream", "--json"]);
    await until(() => fake.inbox("box").acked === 1);
    run.kill();
    await run.code;
    escaped(run.stdout());
    expect((JSON.parse(run.stdout()) as { data: { state: string } }).data.state).toBe(hostile);
  });

  it("never reaches exec's command raw on its stdin, one by one or in a batch", async () => {
    for (const batch of [false, true]) {
      const got = join(cwd, `stdin-${batch}`);
      injectHostile(`e-${batch}`);
      const run = cli(["exec", ...(batch ? ["--batch", "--settle", "0"] : []), "--", "sh", "-c", `cat > ${got}`]);
      await until(() => fake.inbox("box").acked === (batch ? 2 : 1));
      run.kill();
      await run.code;
      const stdin = readFileSync(got, "utf8");
      escaped(stdin);
      const parsed = JSON.parse(stdin) as { kind: string } | { kind: string }[];
      expect((Array.isArray(parsed) ? parsed[0] : parsed).kind).toBe(hostile);
    }
  });

  it("never reaches stdout raw from ls --json, even from an inbox file", async () => {
    const dir = join(env.WATCHERONI_STATE_DIR, "inboxes");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "box.json"), JSON.stringify({
      version: 1, seq: 0, acked: 0, events: [], seen: [],
      watched: { "octo/widgets#7": { target: { owner: "octo", name: "widgets", number: 7 }, addedAt: hostile, snapshot: null } },
    }));
    for (const args of [["ls", "--json"], ["ls", "--all", "--json"]]) {
      const run = cli(args, { WATCHERONI_SERVER: "" });
      expect(await run.code).toBe(0);
      escaped(run.stdout());
      const out = JSON.parse(run.stdout()) as { prs: { since: string }[] } | { prs: { since: string }[] }[];
      expect((Array.isArray(out) ? out[0] : out).prs[0].since).toBe(hostile);
    }
  });

  it("gives exec's command clean variables, and logs its failure cleanly", async () => {
    const log = join(cwd, "ran");
    fake.inject("box", "a\x1b[31m  b", {}, "e\x00vil");
    const script = `printf '%s|%s\\n' "$WATCHERONI_EVENT_ID" "$WATCHERONI_KIND" >> ${log}; exit 1`;
    const run = cli(["exec", "--", "sh", "-c", script]);
    await until(() => run.stderr().includes("command exited 1"));
    run.kill();
    await run.code;
    expect(readFileSync(log, "utf8").split("\n")[0]).toBe("e vil|a [31m b");
    expect(run.stderr()).toContain("watcheroni: command exited 1 for a [31m b (e vil); it will be offered again\n");
  });

  it("can't redirect the CLI elsewhere", async () => {
    fake.redirectTo = "http://evil.test/";
    const run = cli(["wait", "--settle", "0"]);
    expect(await run.code).toBe(1);
    expect(run.stderr()).toBe(`watcheroni: ${fake.url}: PUT /v1/inboxes/box: answered 307 redirecting to "http://evil.test/", which watcheroni doesn't follow; check the server URL in $WATCHERONI_SERVER or ${join(env.WATCHERONI_CONFIG_DIR, "config.json")}\n`);
  });
});

describe("ls --json", () => {
  it("prints the inbox as one JSON object", async () => {
    const run = cli(["ls", "--json"], { WATCHERONI_SERVER: "" });
    expect(await run.code).toBe(0);
    expect(JSON.parse(run.stdout())).toEqual({ inbox: "box", prs: [], repos: [], pending: 0 });
  });
});
