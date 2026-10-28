import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { loadServer } from "./config.ts";
import { Feed } from "./feed.ts";
import { formatText, footer } from "./format.ts";
import { LoginNeeded } from "./github.ts";
import { Inbox, InboxBusy } from "./inbox.ts";
import { LoginFailed, githubTokenFor, login, logout } from "./login.ts";
import { pollOnce } from "./poll.ts";
import { ServerClient, ServerError, ServerReader, Unreachable, subscribe } from "./server.ts";
import { UsageError, currentBranchPr, parseTarget, targetKey } from "./targets.ts";

// Exit codes (DESIGN.md, "The CLI").
const EXIT = { events: 0, error: 1, timeout: 2, ended: 3, login: 4 } as const;

const HELP = `watcheroni ${pkg.version}: wait for, stream, or act on what happens to GitHub pull requests

Usage:
  watcheroni wait   [target...] [--timeout 1h] [--settle 20s] [--format text|json]
  watcheroni stream [target...]
  watcheroni exec   [target...] [--on kinds] [--batch] -- command [args...]
  watcheroni watch  [target...]
  watcheroni unwatch <target...>
  watcheroni ls
  watcheroni login | logout   sign in to the server ($WATCHERONI_SERVER)

Targets are owner/repo#123 or a pull request URL. With none, the open PR
for the current git branch.

Options:
  --inbox NAME      which inbox to use (default: $WATCHERONI_INBOX, or
                    cc-$CLAUDE_CODE_SESSION_ID in Claude Code, or "default")
  --kinds LIST      only these kinds, e.g. check.*,review.submitted
  --interval TIME   how often to poll GitHub (default 2m, at least 10s)

wait exits 0 after printing events, 2 on timeout, 3 when every watched PR
has ended, 4 when GitHub credentials are missing, 1 on other errors.

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

async function main(argv: string[]): Promise<number> {
  const split = argv.indexOf("--");
  const command = split === -1 ? [] : argv.slice(split + 1);
  const { values: opts, positionals } = parseArgs({
    args: split === -1 ? argv : argv.slice(0, split),
    allowPositionals: true,
    options: {
      inbox: { type: "string" },
      kinds: { type: "string" },
      on: { type: "string" },
      interval: { type: "string", default: "2m" },
      timeout: { type: "string", default: "1h" },
      settle: { type: "string", default: "20s" },
      format: { type: "string", default: "text" },
      batch: { type: "boolean", default: false },
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

  if (verb === "login") return (await login(), 0);
  if (verb === "logout") return (await logout(), 0);

  if (verb === "ls") {
    const { watched, pending } = Inbox.peek(inboxName);
    if (!watched.length) process.stdout.write(`Inbox ${inboxName} is watching nothing.\n`);
    for (const w of watched) process.stdout.write(`${targetKey(w.target)}  since ${w.addedAt}\n`);
    if (pending) process.stdout.write(`${pending} event(s) not yet read.\n`);
    return 0;
  }
  if (!["wait", "stream", "exec", "watch", "unwatch"].includes(verb)) {
    throw new UsageError(`unknown command ${verb}; see watcheroni --help`);
  }

  const kinds = (opts.on ?? opts.kinds)?.split(",").map((k) => k.trim()).filter(Boolean) ?? [];
  const interval = Math.max(parseDuration(opts.interval), 10_000);
  if (verb === "exec" && !command.length) throw new UsageError("exec needs a command after --");
  if (opts.format !== "text" && opts.format !== "json") throw new UsageError("--format is text or json");

  const config = loadServer();
  const inbox = Inbox.open(inboxName);
  const targets = args.map(parseTarget);

  if (verb === "unwatch") {
    if (!targets.length) throw new UsageError("unwatch needs a target");
    for (const t of targets) {
      if (!inbox.unwatch(targetKey(t))) log(`${targetKey(t)} wasn't being watched in inbox ${inboxName}`);
    }
    return 0;
  }

  // With a server: make sure the inbox exists, which also checks the key.
  const client = config && new ServerClient(config);
  let reachable = false;
  if (client) {
    try {
      await client.ensureInbox(inboxName);
      reachable = true;
    } catch (e) {
      if (!(e instanceof Unreachable)) throw e;
      log(`${e.message}; polling GitHub from this machine instead`);
    }
  }

  if (!targets.length) {
    try {
      targets.push(await currentBranchPr());
    } catch (e) {
      // Fine if the inbox already watches something, e.g. after the
      // branch's PR was merged, or is a server inbox, which subscriptions
      // made elsewhere may feed.
      if (!(e instanceof UsageError || (client && e instanceof LoginNeeded))) throw e;
      if (!inbox.watched().length && !client) throw e;
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

  if (verb === "watch") {
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
        return await waitCommand(feed, { kinds, interval, timeout: parseDuration(opts.timeout), settle: parseDuration(opts.settle), json: opts.format === "json", inbox: inboxName });
      case "stream":
        return await streamCommand(feed, { kinds, interval });
      case "exec":
        return await execCommand(feed, { kinds, interval, batch: opts.batch, settle: parseDuration(opts.settle), command });
    }
  } finally {
    await server?.close();
  }
  return EXIT.error;
}

const RESUBSCRIBE_MS = 60 * 60_000;

async function waitCommand(
  feed: Feed,
  o: { kinds: string[]; interval: number; timeout: number; settle: number; json: boolean; inbox: string },
): Promise<number> {
  const deadline = Date.now() + o.timeout;
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
      process.stdout.write(o.json ? `${JSON.stringify({ events, watching: still })}\n` : `${formatText(events, still, reading())}\n`);
      feed.ack(items);
      return feed.ended() ? EXIT.ended : EXIT.events;
    }
    if (feed.ended()) {
      process.stdout.write(o.json ? `${JSON.stringify({ events: [], watching: [] })}\n` : `${footer([])}\n`);
      return EXIT.ended;
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      const still = feed.watching();
      process.stdout.write(o.json
        ? `${JSON.stringify({ events: [], watching: still, timeout: true })}\n`
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
