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
}

const SEEN_KEPT = 2000;
// An inbox nobody has opened for this long is deleted. A server stops
// feeding one after a week unread, too.
const STALE_MS = 7 * 24 * 3600 * 1000;

export class InboxBusy extends Error {}

export function stateDir(): string {
  if (process.env.WATCHERONI_STATE_DIR) return process.env.WATCHERONI_STATE_DIR;
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "watcheroni");
}

export class Inbox {
  readonly name: string;
  private readonly file: string;
  private readonly lockFile: string;
  private state: State;
  private closed = false;

  private constructor(name: string, dir: string) {
    this.name = name;
    this.file = join(dir, `${name}.json`);
    this.lockFile = join(dir, `${name}.lock`);
    this.state = this.load();
  }

  // Opens the inbox, holding its lock until close() or process exit.
  static open(name: string): Inbox {
    if (!INBOX_NAME.test(name)) throw new UsageError(`${name}: inbox names are 1-64 letters, digits, '.', '_' or '-'`);
    const dir = join(stateDir(), "inboxes");
    mkdirSync(dir, { recursive: true });
    lock(join(dir, `${name}.lock`), name);
    const inbox = new Inbox(name, dir);
    process.once("exit", () => inbox.close());
    inbox.touch();
    sweep(dir, name);
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

  watched(): Watched[] {
    return Object.values(this.state.watched);
  }

  repoWatches(): RepoWatched[] {
    return Object.values(this.state.repos ?? {});
  }

  // Records (or updates) a repository-wide watch. False if it's new.
  watchRepo(key: string, target: RepoTarget, sub: string): boolean {
    const repos = (this.state.repos ??= {});
    const known = !!repos[key];
    repos[key] = { target, addedAt: repos[key]?.addedAt ?? new Date().toISOString(), sub };
    this.save();
    return known;
  }

  // Forgets every repository-wide watch on `owner/name`, returning them.
  unwatchRepo(owner: string, name: string): RepoWatched[] {
    const gone = Object.entries(this.state.repos ?? {}).filter(([, r]) => r.target.owner === owner && r.target.name === name);
    for (const [key] of gone) delete this.state.repos![key];
    if (gone.length) this.save();
    return gone.map(([, r]) => r);
  }

  watch(key: string, target: Target, sub: string | null = null): boolean {
    if (this.state.watched[key]) return false;
    this.state.watched[key] = { target, addedAt: new Date().toISOString(), snapshot: null, ...(sub ? { sub } : {}) };
    this.save();
    return true;
  }

  unwatch(key: string): boolean {
    if (!this.state.watched[key]) return false;
    delete this.state.watched[key];
    this.save();
    return true;
  }

  // Records the server's subscription, or that it declined (null).
  setSubscription(key: string, sub: string | null): void {
    const w = this.state.watched[key];
    if (!w) return;
    if (sub) {
      w.sub = sub;
      delete w.subTriedAt;
    } else {
      w.subTriedAt = new Date().toISOString();
    }
    this.save();
  }

  // The server ended a subscription with a `watch.*` event. A PR that
  // merged, closed or expired is no longer watched; one whose watch was
  // revoked (the App uninstalled, say) or not re-verified is polled from
  // here instead. Returns "repo" when it was a repository-wide watch.
  subscriptionEnded(sub: string, kind: string): "repo" | "pr" | null {
    // A repository-wide watch can't be polled from here, so it's simply over.
    const repo = Object.entries(this.state.repos ?? {}).find(([, r]) => r.sub === sub);
    if (repo) {
      delete this.state.repos![repo[0]];
      this.save();
      return "repo";
    }
    const entry = Object.entries(this.state.watched).find(([, w]) => w.sub === sub);
    if (!entry) return null;
    const [key, w] = entry;
    if (kind === "watch.revoked" || kind === "watch.unverified" || kind === "watch.expired") delete w.sub;
    else delete this.state.watched[key];
    this.save();
    return "pr";
  }

  update(key: string, snapshot: Snapshot): void {
    const w = this.state.watched[key];
    if (w) {
      w.snapshot = snapshot;
      // What older versions kept for checks.completed and merge.*.
      delete (w as { memory?: unknown }).memory;
    }
  }

  // Numbers and saves new events, dropping any seen before.
  append(events: UnsequencedEvent[]): WatchEvent[] {
    const added: WatchEvent[] = [];
    const seen = new Set(this.state.seen);
    for (const e of events) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      this.state.seen.push(e.id);
      const event = { ...e, seq: ++this.state.seq };
      this.state.events.push(event);
      added.push(event);
    }
    this.state.seen = this.state.seen.slice(-SEEN_KEPT);
    this.save();
    return added;
  }

  pending(): WatchEvent[] {
    return [...this.state.events];
  }

  ack(seq: number): void {
    this.state.events = this.state.events.filter((e) => e.seq > seq);
    this.state.acked = Math.max(this.state.acked, seq);
    this.save();
  }

  save(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 1));
    renameSync(tmp, this.file);
  }

  private load(): State {
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as State;
    } catch {
      return { version: 1, seq: 0, acked: 0, events: [], seen: [], watched: {} };
    }
  }
}

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
      lock(lockFile, name, false);
    } catch {
      continue; // In use.
    }
    // Opened and closed again while we were deciding?
    if (stale(`${name}.json`)) tryUnlink(join(dir, `${name}.json`));
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

// Takes the lock file, or throws InboxBusy. The file appears with the PID
// already in it, by linking a file written beforehand, so nobody reads it
// empty. Unless `wait` is false, a lock held by a live process is tried
// again for a moment, as another process's sweep() holds it only briefly.
function lock(file: string, name: string, wait = true): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, String(process.pid));
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        linkSync(tmp, file);
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const pid = holder(file);
      if (pid === null) continue; // Let go meanwhile.
      if (pid === "busy" || (pid && alive(pid))) {
        if (wait && attempt < 5) {
          pause(20);
          continue;
        }
        throw new InboxBusy(`Inbox ${name} is in use${pid === "busy" ? "" : ` by process ${pid}`}, another wait, stream or exec; stop it, or use another inbox with --inbox`);
      }
      steal(file);
    }
  } finally {
    tryUnlink(tmp);
  }
  throw new InboxBusy(`Couldn't lock inbox ${name}`);
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
