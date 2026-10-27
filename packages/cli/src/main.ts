import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { matchesKind, type WatchEvent } from "@watcheroni/protocol";
import pkg from "../package.json" with { type: "json" };
import { formatText, footer } from "./format.ts";
import { LoginNeeded } from "./github.ts";
import { Inbox, InboxBusy } from "./inbox.ts";
import { LoginFailed, login, logout } from "./login.ts";
import { pollOnce } from "./poll.ts";
import { UsageError, currentBranchPr, parseTarget, targetKey, type Target } from "./targets.ts";

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

This version polls GitHub directly with your gh login (or GH_TOKEN). The
token is used only on this machine.
`;

const log = (msg: string) => process.stderr.write(`watcheroni: ${msg}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  const inbox = Inbox.open(inboxName);
  const targets = args.map(parseTarget);

  if (verb === "unwatch") {
    if (!targets.length) throw new UsageError("unwatch needs a target");
    for (const t of targets) {
      if (!inbox.unwatch(targetKey(t))) log(`${targetKey(t)} wasn't being watched in inbox ${inboxName}`);
    }
    return 0;
  }

  if (!targets.length) {
    try {
      targets.push(await currentBranchPr());
    } catch (e) {
      // Fine if the inbox already watches something, e.g. after the
      // branch's PR was merged.
      if (!(e instanceof UsageError) || !inbox.watched().length) throw e;
    }
  }
  for (const t of targets) {
    if (inbox.watch(targetKey(t), t)) log(`watching ${targetKey(t)} in inbox ${inboxName}`);
  }

  switch (verb) {
    case "watch":
      // Set the starting point now, so events from here on are kept.
      await pollOnce(inbox, log);
      return 0;
    case "wait":
      return waitCommand(inbox, { kinds, interval, timeout: parseDuration(opts.timeout), settle: parseDuration(opts.settle), json: opts.format === "json" });
    case "stream":
      return streamCommand(inbox, { kinds, interval });
    case "exec":
      return execCommand(inbox, { kinds, interval, batch: opts.batch, settle: parseDuration(opts.settle), command });
  }
  return EXIT.error;
}

// Pending events that match, acknowledging the rest so they don't wait
// for ever.
function wanted(inbox: Inbox, kinds: string[]): WatchEvent[] {
  const pending = inbox.pending();
  const keep = pending.filter((e) => matchesKind(kinds, e.kind));
  const skip = pending.filter((e) => !matchesKind(kinds, e.kind));
  // Acknowledge up to the first wanted event only, so the order holds.
  const firstKept = keep[0]?.seq ?? Infinity;
  const skippable = skip.filter((e) => e.seq < firstKept).map((e) => e.seq);
  if (skippable.length) inbox.ack(Math.max(...skippable));
  if (!keep.length && skip.length) inbox.ack(Math.max(...skip.map((e) => e.seq)));
  return keep;
}

const watching = (inbox: Inbox) => inbox.watched().map((w) => targetKey(w.target));

async function waitCommand(
  inbox: Inbox,
  o: { kinds: string[]; interval: number; timeout: number; settle: number; json: boolean },
): Promise<number> {
  const deadline = Date.now() + o.timeout;
  let first = true;
  for (;;) {
    // Events left from before (a killed wait, say) come out first.
    if (!first || !wanted(inbox, o.kinds).length) await pollOnce(inbox, log);
    first = false;
    let events = wanted(inbox, o.kinds);
    if (events.length) {
      // Wait a little for related events: a review's comments arrive
      // together, and so do checks.
      if (o.settle > 0 && inbox.watched().length) {
        await sleep(Math.min(o.settle, Math.max(deadline - Date.now(), 0)));
        await pollOnce(inbox, log);
        events = wanted(inbox, o.kinds);
      }
      const still = watching(inbox);
      process.stdout.write(o.json ? `${JSON.stringify({ events, watching: still })}\n` : `${formatText(events, still)}\n`);
      inbox.ack(events[events.length - 1].seq);
      return still.length ? EXIT.events : EXIT.ended;
    }
    if (!inbox.watched().length) {
      process.stdout.write(o.json ? `${JSON.stringify({ events: [], watching: [] })}\n` : `${footer([])}\n`);
      return EXIT.ended;
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      const still = watching(inbox);
      process.stdout.write(o.json
        ? `${JSON.stringify({ events: [], watching: still, timeout: true })}\n`
        : `No new events. ${footer(still)}\n`);
      return EXIT.timeout;
    }
    await sleep(Math.min(o.interval, left));
  }
}

async function streamCommand(inbox: Inbox, o: { kinds: string[]; interval: number }): Promise<number> {
  for (;;) {
    for (const e of wanted(inbox, o.kinds)) {
      process.stdout.write(`${JSON.stringify(e)}\n`);
      inbox.ack(e.seq);
    }
    if (!inbox.watched().length) return EXIT.ended;
    await sleep(o.interval);
    await pollOnce(inbox, log);
  }
}

async function execCommand(
  inbox: Inbox,
  o: { kinds: string[]; interval: number; batch: boolean; settle: number; command: string[] },
): Promise<number> {
  await pollOnce(inbox, log);
  for (;;) {
    const events = wanted(inbox, o.kinds);
    if (events.length && o.batch) {
      if (o.settle > 0) {
        await sleep(o.settle);
        await pollOnce(inbox, log);
      }
      const batch = wanted(inbox, o.kinds);
      const code = await run(o.command, JSON.stringify(batch), { WATCHERONI_COUNT: String(batch.length) });
      if (code === 0) inbox.ack(batch[batch.length - 1].seq);
      else log(`command exited ${code}; the ${batch.length} event(s) will be offered again`);
    } else {
      for (const e of events) {
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
        inbox.ack(e.seq);
      }
    }
    if (!inbox.watched().length && !wanted(inbox, o.kinds).length) return EXIT.ended;
    await sleep(o.interval);
    await pollOnce(inbox, log);
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
    if (e instanceof UsageError || e instanceof InboxBusy || e instanceof LoginFailed) log(e.message);
    else log(e instanceof Error ? e.stack ?? e.message : String(e));
    process.exit(EXIT.error);
  },
);
