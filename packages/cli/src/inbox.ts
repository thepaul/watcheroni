import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { INBOX_NAME, type UnsequencedEvent, type WatchEvent } from "@watcheroni/protocol";
import type { Snapshot } from "./snapshot.ts";
import { UsageError, type RepoTarget, type Target } from "./targets.ts";

// Local mode's stand-in for a server inbox: one JSON file per inbox under
// ~/.local/state/watcheroni/inboxes/, holding what is watched, the last
// snapshot of each PR, and events not yet acknowledged. Events are saved
// before they're shown and removed only when acknowledged, so a process
// killed in between shows them again next time.

export interface Watched {
  target: Target;
  addedAt: string;
  snapshot: Snapshot | null;
  // The server subscription watching it, if the server does; otherwise
  // this machine polls GitHub for it.
  sub?: string;
  // When the server last declined to watch it.
  subTriedAt?: string;
  // The kinds `wait`, `stream` and `exec` report for it; every kind if
  // missing.
  kinds?: string[];
}

// A whole repository, watched by a server subscription only.
export interface RepoWatched {
  target: RepoTarget;
  addedAt: string;
  sub: string;
}

interface State {
  version: 1;
  seq: number;
  acked: number;
  events: WatchEvent[];
  // IDs of recent events, to drop repeats.
  seen: string[];
  watched: Record<string, Watched>;
  // Added after version 1's first release; missing in older files.
  repos?: Record<string, RepoWatched>;
  // The kinds of PRs that ended while watched for only some kinds, by
  // lowercased key, kept until their last events have been read.
  ended?: Record<string, string[]>;
  // Server subscriptions of PRs unwatched here, whose events still queued
  // on the server are dropped as they arrive.
  unwatched?: string[];
}

const SEEN_KEPT = 2000;
const UNWATCHED_KEPT = 200;
// How many times a change waits 20 ms for another process's change to the
// inbox to finish: a change takes a few milliseconds.
const WRITE_TRIES = 250;
// An inbox nobody has opened for this long is deleted. A server stops
// feeding one after a week unread, too.
const STALE_MS = 7 * 24 * 3600 * 1000;

export class InboxBusy extends Error {}

// Inboxes this process has open, closed on exit by one listener however
// many there are.
const opened = new Set<Inbox>();
let closingOnExit = false;

export function stateDir(): string {
  if (process.env.WATCHERONI_STATE_DIR) return process.env.WATCHERONI_STATE_DIR;
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "watcheroni");
}

export class Inbox {
  readonly name: string;
  private readonly file: string;
  private readonly lockFile: string;
  private readonly writeLock: string;
  private state: State;
  private closed = false;

  private constructor(name: string, dir: string) {
    this.name = name;
    this.file = join(dir, `${name}.json`);
    this.lockFile = join(dir, `${name}.lock`);
    this.writeLock = join(dir, `${name}.writing`);
    this.state = this.load();
  }

  // Opens the inbox to read it, holding its lock until close() or process
  // exit: one `wait`, `stream` or `exec` at a time.
  static open(name: string): Inbox {
    const dir = inboxDir(name);
    lock(join(dir, `${name}.lock`), (pid) => `Inbox ${name} is in use${pid ? ` by process ${pid}` : ""}, another wait, stream or exec; stop it, or use another inbox with --inbox`);
    const inbox = new Inbox(name, dir);
    opened.add(inbox);
    if (!closingOnExit) {
      closingOnExit = true;
      process.once("exit", () => {
        for (const i of opened) i.close();
      });
    }
    inbox.touch();
    sweep(dir, name);
    return inbox;
  }

  // Opens the inbox to change what it watches, for `watch` and `unwatch`,
  // without its lock: they may run while a `wait` reads it.
  static edit(name: string): Inbox {
    const inbox = new Inbox(name, inboxDir(name));
    inbox.touch();
    return inbox;
  }

  // Every inbox on this machine, by name, for `ls --all`.
  static names(): string[] {
    let files: string[];
    try {
      files = readdirSync(join(stateDir(), "inboxes"));
    } catch {
      return [];
    }
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
      .filter((n) => INBOX_NAME.test(n))
      .sort();
  }

  // Reads an inbox without locking it, for `ls`.
  static peek(name: string): { watched: Watched[]; repos: RepoWatched[]; pending: number } {
    const inbox = new Inbox(name, join(stateDir(), "inboxes"));
    return { watched: inbox.watched(), repos: inbox.repoWatches(), pending: inbox.state.events.length };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    opened.delete(this);
    // So an inbox used for longer than a week isn't swept as soon as it's let go.
    this.touch();
    release(this.lockFile);
  }

  // Its file's time is when it was last opened or closed, which sweep() goes by.
  private touch(): void {
    const now = new Date();
    try {
      utimesSync(this.file, now, now);
    } catch {
      // Not saved yet.
    }
  }

  // Reads the file again, for what `watch` and `unwatch` have changed.
  refresh(): void {
    this.state = this.load();
  }

  // Every change is made to the file as it is now, under a lock held only
  // while changing it, so `watch` and `unwatch` can change an inbox that a
  // `wait` is reading without either undoing the other's changes.
  private change<T>(fn: (s: State) => T): T {
    lock(this.writeLock, (pid) => `Inbox ${this.name} is being changed${pid ? ` by process ${pid}` : ""}, which hasn't finished`, WRITE_TRIES);
    try {
      this.state = this.load();
      const out = fn(this.state);
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 1));
      renameSync(tmp, this.file);
      return out;
    } finally {
      release(this.writeLock);
    }
  }

  watched(): Watched[] {
    return Object.values(this.state.watched);
  }

  repoWatches(): RepoWatched[] {
    return Object.values(this.state.repos ?? {});
  }

  // Records (or updates) a repository-wide watch. False if it's new.
  watchRepo(key: string, target: RepoTarget, sub: string): boolean {
    return this.change((s) => {
      const repos = (s.repos ??= {});
      const known = !!repos[key];
      repos[key] = { target, addedAt: repos[key]?.addedAt ?? new Date().toISOString(), sub };
      return known;
    });
  }

  // Forgets every repository-wide watch on `owner/name`, returning them.
  unwatchRepo(owner: string, name: string): RepoWatched[] {
    return this.change((s) => {
      const gone = Object.entries(s.repos ?? {}).filter(([, r]) => r.target.owner === owner && r.target.name === name);
      for (const [key] of gone) delete s.repos![key];
      return gone.map(([, r]) => r);
    });
  }

  watch(key: string, target: Target, sub: string | null = null, kinds: string[] = []): boolean {
    return this.change((s) => {
      if (s.watched[key]) return false;
      s.watched[key] = { target, addedAt: new Date().toISOString(), snapshot: null, ...(sub ? { sub } : {}), ...(kinds.length ? { kinds } : {}) };
      return true;
    });
  }

  // Sets the kinds reported for a watched PR; none means every kind.
  setKinds(key: string, kinds: string[]): void {
    this.change((s) => {
      const w = s.watched[key];
      if (!w) return;
      if (kinds.length) w.kinds = kinds;
      else delete w.kinds;
    });
  }

  // Stops watching a PR because it's no longer wanted, dropping its events
  // not yet read. Returns what it was, or null if it wasn't watched. Events
  // that its server subscription has queued are dropped as they arrive.
  unwatch(key: string): Watched | null {
    return this.change((s) => {
      const w = s.watched[key];
      if (!w) return null;
      delete s.watched[key];
      const k = key.toLowerCase();
      s.events = s.events.filter((e) => prKey(e)?.toLowerCase() !== k);
      if (w.sub) s.unwatched = [...(s.unwatched ?? []), w.sub].slice(-UNWATCHED_KEPT);
      return w;
    });
  }

  // Whether `sub` is a subscription whose PR was unwatched.
  wasUnwatched(sub: string): boolean {
    return this.state.unwatched?.includes(sub) ?? false;
  }

  // Stops watching a PR that has ended, keeping its kinds for the events
  // about its end that haven't been read yet.
  end(key: string): void {
    this.change((s) => {
      const kinds = s.watched[key]?.kinds;
      if (kinds) (s.ended ??= {})[key.toLowerCase()] = kinds;
      delete s.watched[key];
    });
  }

  // The kinds reported for the PR `owner/repo#123`, watched or just
  // ended; every kind if none were given.
  kindsFor(key: string): string[] {
    const k = key.toLowerCase();
    const w = this.watched().find((w) => `${w.target.owner}/${w.target.name}#${w.target.number}`.toLowerCase() === k);
    return w ? w.kinds ?? [] : this.state.ended?.[k] ?? [];
  }

  // Forgets the kinds of ended PRs with no events left to read.
  forgetEnded(pending: Set<string>): void {
    if (!Object.keys(this.state.ended ?? {}).some((k) => !pending.has(k))) return;
    this.change((s) => {
      for (const k of Object.keys(s.ended ?? {})) if (!pending.has(k)) delete s.ended![k];
    });
  }

  // Records the server's subscription, or that it declined (null).
  setSubscription(key: string, sub: string | null): void {
    this.change((s) => {
      const w = s.watched[key];
      if (!w) return;
      if (sub) {
        w.sub = sub;
        delete w.subTriedAt;
      } else {
        w.subTriedAt = new Date().toISOString();
      }
    });
  }

  // The server ended a subscription with a `watch.*` event. A PR that
  // merged, closed or expired is no longer watched; one whose watch was
  // revoked (the App uninstalled, say) or not re-verified is polled from
  // here instead. Returns "repo" when it was a repository-wide watch.
  subscriptionEnded(sub: string, kind: string): "repo" | "pr" | null {
    const knows = this.repoWatches().some((r) => r.sub === sub) || this.watched().some((w) => w.sub === sub);
    if (!knows) return null;
    return this.change((s) => {
      // A repository-wide watch can't be polled from here, so it's simply over.
      const repo = Object.entries(s.repos ?? {}).find(([, r]) => r.sub === sub);
      if (repo) {
        delete s.repos![repo[0]];
        return "repo";
      }
      const entry = Object.entries(s.watched).find(([, w]) => w.sub === sub);
      if (!entry) return null;
      const [key, w] = entry;
      if (kind === "watch.revoked" || kind === "watch.unverified" || kind === "watch.expired") {
        delete w.sub;
      } else {
        if (w.kinds) (s.ended ??= {})[key.toLowerCase()] = w.kinds;
        delete s.watched[key];
      }
      return "pr";
    });
  }

  // Saves a PR's latest snapshot and the events found by comparing it with
  // the last, numbering them and dropping any seen before, unless the PR
  // has stopped being watched meanwhile. Returns the events added.
  record(key: string, snapshot: Snapshot, events: UnsequencedEvent[]): WatchEvent[] {
    return this.change((s) => {
      const w = s.watched[key];
      if (!w) return [];
      w.snapshot = snapshot;
      // What older versions kept for checks.completed and merge.*.
      delete (w as { memory?: unknown }).memory;
      return add(s, events);
    });
  }

  // Numbers and saves new events, dropping any seen before.
  append(events: UnsequencedEvent[]): WatchEvent[] {
    return this.change((s) => add(s, events));
  }

  pending(): WatchEvent[] {
    return [...this.state.events];
  }

  ack(seq: number): void {
    this.change((s) => {
      s.events = s.events.filter((e) => e.seq > seq);
      s.acked = Math.max(s.acked, seq);
    });
  }

  private load(): State {
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as State;
    } catch {
      return { version: 1, seq: 0, acked: 0, events: [], seen: [], watched: {} };
    }
  }
}

function inboxDir(name: string): string {
  if (!INBOX_NAME.test(name)) throw new UsageError(`${name}: inbox names are 1-64 letters, digits, '.', '_' or '-'`);
  const dir = join(stateDir(), "inboxes");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function add(s: State, events: UnsequencedEvent[]): WatchEvent[] {
  const added: WatchEvent[] = [];
  const seen = new Set(s.seen);
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    s.seen.push(e.id);
    const event = { ...e, seq: ++s.seq };
    s.events.push(event);
    added.push(event);
  }
  s.seen = s.seen.slice(-SEEN_KEPT);
  return added;
}

export const prKey = (e: { repo: { full_name: string } | null; pr: number | null }) => (e.repo && e.pr !== null ? `${e.repo.full_name}#${e.pr}` : null);

// Deletes the inboxes nobody has opened for STALE_MS, except `keep` and
// any in use, with what they watched and any events never acknowledged.
// One that's wanted again starts out empty.
function sweep(dir: string, keep: string): void {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return;
  }
  const stale = (file: string) => {
    try {
      return Date.now() - statSync(join(dir, file)).mtimeMs > STALE_MS;
    } catch {
      return false;
    }
  };
  const names = new Set<string>();
  for (const file of files) {
    // Left by a save that was killed.
    if (file.endsWith(".tmp") && stale(file)) tryUnlink(join(dir, file));
    const m = /^(.*)\.(json|lock)$/.exec(file);
    if (m && INBOX_NAME.test(m[1]!) && m[1] !== keep) names.add(m[1]!);
  }
  for (const name of names) {
    // A lock with no inbox file is one opened but never saved.
    if (!(files.includes(`${name}.json`) ? stale(`${name}.json`) : stale(`${name}.lock`))) continue;
    const lockFile = join(dir, `${name}.lock`);
    try {
      lock(lockFile, () => "in use", 1);
    } catch {
      continue; // In use.
    }
    // Opened and closed again while we were deciding?
    if (stale(`${name}.json`)) {
      tryUnlink(join(dir, `${name}.json`));
      // Left by a change that was killed.
      tryUnlink(join(dir, `${name}.writing`));
    }
    release(lockFile);
  }
}

function tryUnlink(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Already gone.
  }
}

// Takes the lock file, or throws InboxBusy with `busy`'s message. The file
// appears with the PID already in it, by linking a file written
// beforehand, so nobody reads it empty. A lock held by a live process is
// tried again every 20 ms, `tries` times in all: by default for a moment,
// as another process's sweep() holds a reading lock only briefly. One left
// by a process that has gone is taken over.
function lock(file: string, busy: (pid: number | null) => string, tries = 6): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, String(process.pid));
  try {
    let waits = 0;
    for (let attempt = 0; attempt < tries + 5; attempt++) {
      try {
        linkSync(tmp, file);
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const pid = holder(file);
      if (pid === null) continue; // Let go meanwhile.
      if (pid === "busy" || (pid && alive(pid))) {
        if (++waits < tries) {
          pause(20);
          continue;
        }
        throw new InboxBusy(busy(pid === "busy" ? null : pid));
      }
      steal(file);
    }
  } finally {
    tryUnlink(tmp);
  }
  throw new InboxBusy(busy(null));
}

// The PID in a lock file, null if it's gone, or "busy" if it's empty and
// new: an older version of this CLI writes the PID after making the file.
function holder(file: string): number | "busy" | null {
  try {
    const pid = Number(readFileSync(file, "utf8"));
    if (pid) return pid;
    return Date.now() - statSync(file).mtimeMs < 10_000 ? "busy" : 0;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

// Removes a lock left by a process that has gone. It's moved aside first
// and checked again, so if another process replaced it meanwhile, theirs
// is put back rather than deleted.
function steal(file: string): void {
  const aside = `${file}.${process.pid}.stale.tmp`;
  try {
    renameSync(file, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  const pid = holder(aside);
  if (pid === "busy" || (pid && alive(pid))) {
    try {
      linkSync(aside, file);
    } catch {
      // Taken again already.
    }
  }
  tryUnlink(aside);
}

// Lets go of a lock, if it's still this process's.
function release(file: string): void {
  try {
    if (Number(readFileSync(file, "utf8")) === process.pid) unlinkSync(file);
  } catch {
    // Already gone.
  }
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
