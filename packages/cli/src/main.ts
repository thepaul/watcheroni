import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import type { WatchEvent } from "@watcheroni/protocol";
import pkg from "../package.json" with { type: "json" };
import { loadServer } from "./config.ts";
import { Feed } from "./feed.ts";
import { formatText, footer } from "./format.ts";
import { LoginNeeded } from "./github.ts";
import { Inbox, InboxBusy } from "./inbox.ts";
import { LoginFailed, githubTokenFor, login, logout } from "./login.ts";
import { pollOnce } from "./poll.ts";
import { selfhost } from "./selfhost.ts";
import { RENEW_EVERY_MS, ServerClient, ServerError, ServerReader, Unreachable, renewSubscriptions, subscribe } from "./server.ts";
import { UsageError, currentBranchPr, isPr, parseTarget, repoKey, targetKey, type RepoTarget, type Target } from "./targets.ts";

// Exit codes (DESIGN.md, "The CLI").
const EXIT = { events: 0, error: 1, timeout: 2, ended: 3, login: 4 } as const;

const HELP = `watcheroni ${pkg.version}: wait for, stream, or act on what happens to GitHub pull requests

Usage:
  watcheroni wait   [target...] [--timeout 1h] [--settle 5s] [--json]
  watcheroni stream [target...]
  watcheroni exec   [target...] [--on kinds] [--batch] [--settle 5s] -- command [args...]
  watcheroni watch  [target...]
  watcheroni unwatch <target...>
  watcheroni ls [--all]       what the inbox watches; --all: every inbox here
  watcheroni login | logout   sign in to the server ($WATCHERONI_SERVER)
  watcheroni selfhost [--help] run your own server (from a watcheroni clone)

Targets are owner/repo#123 or a pull request URL. With none, the open PR
for the current git branch. owner/repo watches the whole repository, with
the server only, and needs --kinds.

Options:
  --inbox NAME      which inbox to use (default: $WATCHERONI_INBOX, or
                    cc-$CLAUDE_CODE_SESSION_ID in Claude Code, or "default")
  --kinds LIST      only these kinds, e.g. check.*,review.submitted
  --base BRANCH     owner/repo targets: only PRs against this branch
  --author LOGIN    owner/repo targets: only PRs opened by this GitHub user
  --interval TIME   how often to poll GitHub (default 2m, at least 10s)
  --settle TIME     wait and exec --batch: after the first event, wait this
                    long for more before printing or running the command
                    (default 5s; 0 goes with what the first read brought)
  --json            wait: each event as a JSON line, then, on exit 0, 2 or
                    3, {"result":"events|timeout|ended","watching":[...]};
                    stream: JSON lines, as without it; ls: one JSON value

wait exits 0 after printing events, 2 on timeout, 3 when every watched PR
has ended (never while a whole repository is watched), 4 when GitHub
credentials are missing, 1 on other errors.

With a server ($WATCHERONI_SERVER and $WATCHERONI_API_KEY, or
~/.config/watcheroni), wait, stream and exec read the inbox on the server.
Without one, or when it can't be reached, they poll GitHub from this
machine with your gh login (or GH_TOKEN). That token is never sent to the
server.
`;

const log = (msg: string) => process.stderr.write(`watcheroni: ${msg}\n`);

export function parseDuration(s: string): number {
  const m = s.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/);
  if (!m) throw new UsageError(`${s}: expected a duration like 30s, 2m or 1h`);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] ?? "s"]!;
  return Number(m[1]) * unit;
}

// What an inbox watches and how many events wait in it, a line each.
function describeInbox(name: string, nothing: string): string[] {
  const { watched, repos, pending } = Inbox.peek(name);
  return [
    ...(!watched.length && !repos.length ? [nothing] : []),
    ...watched.map((w) => `${targetKey(w.target)}  since ${w.addedAt}`),
    ...repos.map((r) => `${repoKey(r.target)}  since ${r.addedAt}`),
    ...(pending ? [`${pending} event(s) not yet read.`] : []),
  ];
}

// The same, for `ls --json`.
function inboxJson(name: string): object {
  const { watched, repos, pending } = Inbox.peek(name);
  return {
    inbox: name,
    prs: watched.map((w) => ({ pr: targetKey(w.target), since: w.addedAt })),
    repos: repos.map(({ target: t, addedAt }) => ({
      repo: `${t.owner}/${t.name}`,
      kinds: t.kinds,
      ...(t.base ? { base: t.base } : {}),
      ...(t.author ? { author: t.author } : {}),
      since: addedAt,
    })),
    pending,
  };
}

async function main(argv: string[]): Promise<number> {
  // Its options are the server script's own.
  if (argv[0] === "selfhost") return selfhost(argv.slice(1));
  const split = argv.indexOf("--");
  const command = split === -1 ? [] : argv.slice(split + 1);
  const { values: opts, positionals } = parseArgs({
    args: split === -1 ? argv : argv.slice(0, split),
    allowPositionals: true,
    options: {
      inbox: { type: "string" },
      kinds: { type: "string" },
      base: { type: "string" },
      author: { type: "string" },
      on: { type: "string" },
      interval: { type: "string", default: "2m" },
      timeout: { type: "string", default: "1h" },
      settle: { type: "string", default: "5s" },
      // Before --json: wait's events as one JSON object. Kept for scripts.
      format: { type: "string" },
      json: { type: "boolean", default: false },
      batch: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  const [verb, ...args] = positionals;
  if (opts.version) {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }
  if (opts.help || !verb || verb === "help") {
    process.stdout.write(HELP);
    return verb || opts.help ? 0 : EXIT.error;
  }

  const inboxName = opts.inbox
    ?? process.env.WATCHERONI_INBOX
    ?? (process.env.CLAUDE_CODE_SESSION_ID ? `cc-${process.env.CLAUDE_CODE_SESSION_ID}` : "default");

  if (opts.json && !["wait", "stream", "ls"].includes(verb)) throw new UsageError(`${verb} has no --json; wait, stream and ls do`);

  if (verb === "login") return (await login(), 0);
  if (verb === "logout") return (await logout(), 0);

  if (verb === "ls") {
    if (opts.json) {
      if (!opts.all) {
        process.stdout.write(`${JSON.stringify(inboxJson(inboxName))}\n`);
        return 0;
      }
      let unreadable = 0;
      const all = Inbox.names().map((name) => {
        try {
          return inboxJson(name);
        } catch (e) {
          unreadable++;
          return { inbox: name, error: e instanceof Error ? e.message : String(e) };
        }
      });
      process.stdout.write(`${JSON.stringify(all)}\n`);
      return unreadable ? EXIT.error : 0;
    }
    if (!opts.all) {
      process.stdout.write(describeInbox(inboxName, `Inbox ${inboxName} is watching nothing.`).map((l) => `${l}\n`).join(""));
      return 0;
    }
    const names = Inbox.names();
    if (!names.length) process.stdout.write("No inboxes on this machine.\n");
    // One unreadable inbox file doesn't hide the rest; it fails the command at the end.
    let unreadable = 0;
    for (const name of names) {
      let lines: string[];
      try {
        lines = describeInbox(name, "watching nothing.");
      } catch (e) {
        unreadable++;
        lines = [`can't be read: ${e instanceof Error ? e.message : String(e)}`];
      }
      process.stdout.write(`${name}:\n${lines.map((l) => `  ${l}\n`).join("")}`);
    }
    return unreadable ? EXIT.error : 0;
  }
  if (!["wait", "stream", "exec", "watch", "unwatch"].includes(verb)) {
    throw new UsageError(`unknown command ${verb}; see watcheroni --help`);
  }

  const kinds = (opts.on ?? opts.kinds)?.split(",").map((k) => k.trim()).filter(Boolean) ?? [];
  const interval = Math.max(parseDuration(opts.interval), 10_000);
  if (verb === "exec" && !command.length) throw new UsageError("exec needs a command after --");
  if (opts.format !== undefined && opts.format !== "text" && opts.format !== "json") throw new UsageError("--format is text or json");
  if (opts.json && opts.format !== undefined) throw new UsageError("--json replaces --format; use one or the other");

  const config = loadServer();
  const parsed = args.map(parseTarget);
  const targets: Target[] = parsed.filter(isPr);
  const repoTargets: RepoTarget[] = parsed.filter((t) => !isPr(t)).map((t) => ({
    ...t,
    kinds,
    ...(opts.base ? { base: opts.base } : {}),
    ...(opts.author ? { author: opts.author } : {}),
  }));
  if ((opts.base || opts.author) && !repoTargets.length) throw new UsageError("--base and --author are for whole-repository targets (owner/repo)");
  if (verb !== "unwatch") {
    for (const t of repoTargets) {
      const repo = `${t.owner}/${t.name}`;
      if (!config) {
        throw new UsageError(`${repo}: watching a whole repository needs the watcheroni server (see \`watcheroni login\`); from this machine it would mean polling every PR in it. Name a PR instead (${repo}#123)`);
      }
      if (!kinds.length) throw new UsageError(`${repo}: watching a whole repository needs --kinds, e.g. --kinds pr.opened`);
    }
  }
  const inbox = Inbox.open(inboxName);
  const client = config && new ServerClient(config);

  if (verb === "unwatch") {
    if (!parsed.length) throw new UsageError("unwatch needs a target");
    for (const t of targets) {
      if (!inbox.unwatch(targetKey(t))) log(`${targetKey(t)} wasn't being watched in inbox ${inboxName}`);
    }
    // A repository-wide watch is only on the server, so it's ended there.
    for (const t of repoTargets) {
      const gone = inbox.unwatchRepo(t.owner, t.name);
      if (!gone.length) log(`${t.owner}/${t.name} wasn't being watched as a whole in inbox ${inboxName}`);
      if (!client) {
        for (const r of gone) {
          log(`stopped watching ${repoKey(r.target)} here, but with no server configured its subscription there wasn't ended; it ends after a week nobody reads inbox ${inboxName}`);
        }
        continue;
      }
      for (const r of gone) {
        await client.request("DELETE", `/v1/inboxes/${inboxName}/subscriptions/${r.sub}`).catch((e: unknown) => {
          if (!(e instanceof ServerError && e.status === 404)) log(`couldn't end the server's watch on ${repoKey(r.target)}: ${(e as Error).message}`);
        });
      }
    }
    return 0;
  }

  // With a server: make sure the inbox exists, which also checks the key.
  let reachable = false;
  if (client) {
    try {
      await client.ensureInbox(inboxName);
      reachable = true;
    } catch (e) {
      if (!(e instanceof Unreachable)) throw e;
      if (repoTargets.length) throw new Unreachable(`${e.message}; a whole repository can only be watched by the server`);
      log(`${e.message}; polling GitHub from this machine instead`);
    }
  }

  // Whole repositories: subscribed on the server, or not at all.
  for (const t of client && reachable ? repoTargets : []) {
    const key = repoKey(t);
    const known = inbox.repoWatches().find((r) => repoKey(r.target) === key);
    if (known) continue;
    const sub = await subscribe(client!, inboxName, t, { log, githubToken: () => githubTokenFor(client!.url) });
    if (!sub) throw new ServerError(`can't watch ${key}: the server won't, and a whole repository can't be watched from this machine`, 0, "refused");
    inbox.watchRepo(key, t, sub);
    log(`watching ${key} in inbox ${inboxName}`);
  }

  if (!targets.length && !repoTargets.length) {
    try {
      targets.push(await currentBranchPr());
    } catch (e) {
      // Fine if the inbox already watches something, e.g. after the
      // branch's PR was merged, or is a server inbox, which subscriptions
      // made elsewhere may feed. Reading also goes on while the inbox
      // still holds events, such as the `watch.ended` of a PR that ended
      // before anything read it.
      if (!(e instanceof UsageError || (client && e instanceof LoginNeeded))) throw e;
      if (!inbox.watched().length && !client) {
        if (verb === "watch" || !inbox.pending().length) throw e;
        log(`${(e as Error).message}; reading the events left in inbox ${inboxName}`);
      }
    }
  }
  for (const t of targets) {
    const key = targetKey(t);
    const known = inbox.watched().find((w) => targetKey(w.target) === key);
    // A PR polled from here so far is offered to the server again, in
    // case the App has been installed since: every time it's named on the
    // command line, and at most hourly when it's the current branch's.
    const tried = known?.subTriedAt ? Date.parse(known.subTriedAt) : 0;
    const throttled = !args.length && Date.now() - tried < RESUBSCRIBE_MS;
    if (known && (known.sub || !reachable || throttled)) continue;
    const sub = client && reachable ? await subscribe(client, inboxName, t, { log, githubToken: () => githubTokenFor(client.url) }) : null;
    if (known) {
      inbox.setSubscription(key, sub);
      continue;
    }
    inbox.watch(key, t, sub);
    if (client && reachable && !sub) inbox.setSubscription(key, null);
    log(`watching ${key} in inbox ${inboxName}${client && !sub ? ", polling GitHub from this machine" : ""}`);
  }

  // Private repos' subscriptions need a fresh token now and then; long
  // runs check again every few hours.
  const renew = () => client ? renewSubscriptions(client, inboxName, { log, githubToken: () => githubTokenFor(client.url) }) : Promise.resolve();
  if (reachable) await renew();
  const renewTimer = client ? setInterval(() => void renew().catch((e: unknown) => log(`renewing subscriptions: ${(e as Error).message}`)), RENEW_EVERY_MS) : null;
  renewTimer?.unref();

  if (verb === "watch") {
    clearInterval(renewTimer ?? undefined);
    // Set the starting point now, so events from here on are kept.
    await pollOnce(inbox, log, undefined, !reachable);
    return 0;
  }

  let server: ServerReader | null = null;
  if (client) {
    server = new ServerReader(client, inboxName, { log });
    const connected = await server.start();
    if (!connected && reachable) log(`can't read inbox ${inboxName} on ${client.url}; polling GitHub from this machine meanwhile`);
    if (!connected && verb === "wait" && !inbox.watched().length) {
      await server.close();
      throw new Unreachable(`can't reach ${client.url}, and inbox ${inboxName} watches no PR to poll from here instead`);
    }
  }
  const feed = new Feed(inbox, server, { interval, log });
  try {
    switch (verb) {
      case "wait":
        return await waitCommand(feed, { kinds, interval, timeout: parseDuration(opts.timeout), settle: parseDuration(opts.settle), output: opts.json ? "lines" : opts.format === "json" ? "object" : "text", inbox: inboxName });
      case "stream":
        return await streamCommand(feed, { kinds, interval });
      case "exec":
        return await execCommand(feed, { kinds, interval, batch: opts.batch, settle: parseDuration(opts.settle), command });
    }
  } finally {
    clearInterval(renewTimer ?? undefined);
    await server?.close();
  }
  return EXIT.error;
}

const RESUBSCRIBE_MS = 60 * 60_000;

async function waitCommand(
  feed: Feed,
  o: { kinds: string[]; interval: number; timeout: number; settle: number; output: "text" | "lines" | "object"; inbox: string },
): Promise<number> {
  const deadline = Date.now() + o.timeout;
  // --json: a line per event, then one saying how the wait ended.
  const lines = (events: WatchEvent[], result: "events" | "timeout" | "ended", watching: string[]) =>
    [...events, { result, watching }].map((v) => `${JSON.stringify(v)}\n`).join("");
  // A server inbox still being read with no PR known to be watched.
  const reading = () => (feed.ended() ? undefined : o.inbox);
  // Events left from before (a killed wait, say) come out first.
  if (!feed.wanted(o.kinds).length) await feed.poll();
  for (;;) {
    let items = feed.wanted(o.kinds);
    if (items.length) {
      // Wait a little for related events: a review's comments arrive
      // together, and so do checks.
      if (o.settle > 0 && !feed.ended()) {
        await feed.settle(Math.min(o.settle, Math.max(deadline - Date.now(), 0)));
        items = feed.wanted(o.kinds);
      }
      const events = items.map((i) => i.event);
      const still = feed.watching();
      const ended = feed.ended();
      process.stdout.write(o.output === "lines" ? lines(events, ended ? "ended" : "events", still)
        : o.output === "object" ? `${JSON.stringify({ events, watching: still })}\n`
        : `${formatText(events, still, reading(), feed.repoEnded)}\n`);
      feed.ack(items);
      return ended ? EXIT.ended : EXIT.events;
    }
    if (feed.ended()) {
      process.stdout.write(o.output === "lines" ? lines([], "ended", [])
        : o.output === "object" ? `${JSON.stringify({ events: [], watching: [] })}\n`
        : `${footer([], undefined, feed.repoEnded)}\n`);
      return EXIT.ended;
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      const still = feed.watching();
      process.stdout.write(o.output === "lines" ? lines([], "timeout", still)
        : o.output === "object" ? `${JSON.stringify({ events: [], watching: still, timeout: true })}\n`
        : `No new events. ${footer(still, reading())}\n`);
      return EXIT.timeout;
    }
    await feed.more(Math.min(o.interval, left));
  }
}

async function streamCommand(feed: Feed, o: { kinds: string[]; interval: number }): Promise<number> {
  for (;;) {
    for (const item of feed.wanted(o.kinds)) {
      process.stdout.write(`${JSON.stringify(item.event)}\n`);
      feed.ack([item]);
    }
    if (feed.ended()) return EXIT.ended;
    await feed.more(o.interval);
  }
}

async function execCommand(
  feed: Feed,
  o: { kinds: string[]; interval: number; batch: boolean; settle: number; command: string[] },
): Promise<number> {
  await feed.poll();
  for (;;) {
    const items = feed.wanted(o.kinds);
    if (items.length && o.batch) {
      if (o.settle > 0) await feed.settle(o.settle);
      const batch = feed.wanted(o.kinds);
      const code = await run(o.command, JSON.stringify(batch.map((i) => i.event)), { WATCHERONI_COUNT: String(batch.length) });
      if (code === 0) feed.ack(batch);
      else log(`command exited ${code}; the ${batch.length} event(s) will be offered again`);
    } else {
      for (const item of items) {
        const e = item.event;
        const code = await run(o.command, JSON.stringify(e), {
          WATCHERONI_KIND: e.kind,
          WATCHERONI_REPO: e.repo?.full_name ?? "",
          WATCHERONI_PR: e.pr === null ? "" : String(e.pr),
          WATCHERONI_URL: e.links.html ?? "",
          WATCHERONI_EVENT_ID: e.id,
        });
        if (code !== 0) {
          // Stop here so events stay in order; this one is offered again
          // after the next poll.
          log(`command exited ${code} for ${e.kind} (${e.id}); it will be offered again`);
          break;
        }
        feed.ack([item]);
      }
    }
    if (feed.ended() && !feed.wanted(o.kinds).length) return EXIT.ended;
    await feed.more(o.interval);
  }
}

function run(command: string[], stdin: string, env: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "inherit", "inherit"], env: { ...process.env, ...env } });
    child.on("error", (e) => {
      log(`couldn't run ${command[0]}: ${e.message}`);
      resolve(127);
    });
    child.on("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
    child.stdin.on("error", () => {
      // The command didn't read its input; that's its business.
    });
    child.stdin.end(stdin);
  });
}

// So the inbox lock is released on Ctrl-C and kill.
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

// The plugin's wrapper sets this so it can't run itself in a loop; a
// command `exec` runs should look for watcheroni afresh.
delete process.env.WATCHERONI_WRAPPER;

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof LoginNeeded) {
      log(e.message);
      process.exit(EXIT.login);
    }
    if (e instanceof UsageError || e instanceof InboxBusy || e instanceof LoginFailed || e instanceof Unreachable || e instanceof ServerError) log(e.message);
    else log(e instanceof Error ? e.stack ?? e.message : String(e));
    process.exit(EXIT.error);
  },
);
