import { closeSync, existsSync, futimesSync, linkSync, openSync, writeSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
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
  // Seqs of the events here that came from the server's inbox and were
  // taken back from its reader (see hold()): shown before the server's.
  held?: number[];
}

const SEEN_KEPT = 2000;
const UNWATCHED_KEPT = 200;
// How many times a change waits 20 ms for another process's change to the
// inbox to finish: a change takes a few milliseconds.
const WRITE_TRIES = 250;
// An inbox nobody has opened for this long is deleted, here and on the
// server. A server stops feeding one after a week unread, too.
export const STALE_MS = 7 * 24 * 3600 * 1000;
// How many times sweep() asks the server to delete an inbox, when it says
// when to try again, and the longest it waits for that.
const SWEEP_TRIES = 3;
const SWEEP_RETRY_MAX_SECONDS = 60;
// How many stale inboxes one sweep takes to the server: a backlog, such
// as Claude Code sessions' inboxes, is cleared a few at a time rather than
// crowd the account's rate limit.
const SWEEP_SERVER_MAX = 5;
// How long a sweep gives the server to say whether it can delete inboxes
// safely, and to delete one: longer than the 60 s a server's delete may
// hold an inbox, so a sweep that isn't cut short never lets go of one the
// server may still delete. (One cut short, by the exit grace or a signal,
// can: a reader that opens the inbox then may be closed with 4004 if the
// server's delete finishes.) Inbox.openWaiting() waits for a sweep
// holding the lock that long.
export const SWEEP_REQUEST_MS = 10_000;
export const SWEEP_DELETE_MS = 70_000;
const SWEEP_HOLD_MS = SWEEP_REQUEST_MS + SWEEP_DELETE_MS + 5000;

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
  // exit: one `wait`, `stream` or `exec` at a time. (Those also run
  // sweep() for the other inboxes; see main.ts.)
  static open(name: string): Inbox {
    const dir = inboxDir(name);
    lock(join(dir, `${name}.lock`), (pid) => `Inbox ${name} is in use${pid ? ` by process ${pid}` : ""}, another wait, stream or exec; stop it, or use another inbox with --inbox`);
    return Inbox.opened(name, dir);
  }

  // open(), but if another process's sweep holds the lock while deleting
  // the inbox on the server, waits till it's done (without blocking, so
  // Ctrl-C still works), and the inbox then starts out empty. Stops waiting
  // once whoever holds the lock is no longer a sweep.
  static async openWaiting(name: string, log: (msg: string) => void = () => {}): Promise<Inbox> {
    const dir = inboxDir(name);
    for (let until = 0; ; ) {
      try {
        return Inbox.open(name);
      } catch (e) {
        if (!(e instanceof InboxBusy) || !beingSwept(dir, name)) throw e;
        if (!until) {
          until = Date.now() + SWEEP_HOLD_MS;
          log(`waiting for another process to finish deleting inbox ${name} on the server, as nobody had used it for a week`);
        }
        if (Date.now() > until) throw new InboxBusy(`Inbox ${name} is still being deleted, as nobody had used it for a week; try again shortly`);
      }
      await pauseAsync(100);
    }
  }

  private static opened(name: string, dir: string): Inbox {
    const inbox = new Inbox(name, dir);
    opened.add(inbox);
    if (!closingOnExit) {
      closingOnExit = true;
      process.once("exit", () => {
        for (const i of opened) i.close();
      });
    }
    inbox.touch();
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
      if (s.held) s.held = s.held.filter((seq) => s.events.some((e) => e.seq === seq));
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

  // Takes exactly these events (as pending() gave them) as handled.
  handled(events: WatchEvent[]): void {
    if (!events.length) return;
    const done = new Set(events.map((e) => e.seq));
    this.change((s) => {
      s.events = s.events.filter((e) => !done.has(e.seq));
      if (s.held) s.held = s.held.filter((seq) => !done.has(seq));
      for (const seq of done) s.acked = Math.max(s.acked, seq);
    });
  }

  // Keeps events from the server's inbox that its reader took back when
  // an inbox.gap moved its position back (ServerReader's takeBack): saved
  // here, under this inbox's own numbering, till they're handled, as the
  // server no longer has them to send again.
  hold(events: WatchEvent[]): void {
    this.change((s) => {
      const added = add(s, events.map(({ seq: _, ...e }) => e));
      s.held = [...(s.held ?? []), ...added.map((e) => e.seq)];
    });
  }

  // Seqs of the pending events hold() kept.
  heldSeqs(): Set<number> {
    return new Set(this.state.held ?? []);
  }

  private load(): State {
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as State;
    } catch {
      return emptyState();
    }
  }
}

// Whether a live process's sweep holds the inbox's lock: the PID in its
// `.sweep` file is the lock's.
function beingSwept(dir: string, name: string): boolean {
  try {
    const pid = Number(readFileSync(join(dir, `${name}.sweep`), "utf8"));
    return !!pid && pid === Number(readFileSync(join(dir, `${name}.lock`), "utf8")) && alive(pid);
  } catch {
    return false;
  }
}

function markerAlive(file: string): boolean {
  try {
    const pid = Number(readFileSync(file, "utf8"));
    return !!pid && alive(pid);
  } catch {
    return false;
  }
}

function emptyState(): State {
  return { version: 1, seq: 0, acked: 0, events: [], seen: [], watched: {} };
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

// What sweep() asks the server: to delete its copy of a stale inbox (see
// staleInboxDeleter() in server.ts), or null with no server. `done` once
// there's none left for this machine to delete; otherwise `retryAfter`
// (seconds) if the server said when to try again.
// `local` when the server can't delete inboxes, so it wasn't asked.
// `later` when another delete of it is under way, so it's left for a later
// sweep.
export type DeleteOnServer = (name: string) => Promise<{ done: true; local?: true } | { done: false; retryAfter: number | null; later?: true }>;

// Deletes the inboxes nobody has opened for STALE_MS, except `keep` and
// any in use, with what they watched and any events never acknowledged.
// One that's wanted again starts out empty. With a server, its inbox of
// the same name goes first, and the local file is deleted only once the
// server's is gone (or is in use elsewhere): till then the file stays,
// still stale, as the record of what's left to delete, and a later sweep
// tries again. At most SWEEP_SERVER_MAX inboxes are taken to the server
// in one sweep, so a backlog is cleared a few at a time.
export async function sweep(keep: string, deleteOnServer: DeleteOnServer | null, wait = pauseAsync): Promise<void> {
  const dir = join(stateDir(), "inboxes");
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return;
  }
  const names = new Set<string>();
  for (const file of files) {
    // Left by a save that was killed.
    if (file.endsWith(".tmp") && stale(dir, file)) tryUnlink(join(dir, file));
    // Left by a sweep cut short.
    if (file.endsWith(".sweep") && !markerAlive(join(dir, file))) tryUnlink(join(dir, file));
    const m = /^(.*)\.(json|lock)$/.exec(file);
    if (m && INBOX_NAME.test(m[1]!) && m[1] !== keep) names.add(m[1]!);
  }
  let asked = 0;
  names: for (const name of names) {
    for (let attempt = 1; ; attempt++) {
      const outcome = await sweepOne(dir, name, deleteOnServer);
      if (outcome === "asked") asked++;
      if (typeof outcome !== "number") {
        // Unreachable, refusing, or enough for one sweep: the rest wait for another.
        if (outcome === "stop" || asked >= SWEEP_SERVER_MAX) break names;
        break;
      }
      if (attempt >= SWEEP_TRIES || outcome > SWEEP_RETRY_MAX_SECONDS) break names;
      await wait(outcome * 1000);
    }
  }
}

// Whether a file in `dir` is older than STALE_MS; false if it isn't there.
function stale(dir: string, file: string): boolean {
  const t = mtime(dir, file);
  return t !== null && Date.now() - t > STALE_MS;
}

function mtime(dir: string, file: string): number | null {
  try {
    return statSync(join(dir, file)).mtimeMs;
  } catch {
    return null;
  }
}

// Sweeps one inbox if it's stale and not in use. Returns "skipped" if it
// isn't to be swept; "done" once it's deleted without asking the server,
// "asked" once with (or left for later, if another delete of it is under
// way); the seconds to wait before trying again, if the
// server said; or "stop" if the server couldn't delete it and didn't say
// when to try again.
//
// Its lock is held while the server is asked, so nobody opens it
// meanwhile; a `<name>.sweep` file with this process's PID says why, so
// Inbox.openWaiting() waits for it rather than call it in use (see SWEEP_HOLD_MS).
// `watch` and `unwatch` take no lock, so whether it's still stale is
// checked again after asking: one used meanwhile is kept.
async function sweepOne(dir: string, name: string, deleteOnServer: DeleteOnServer | null): Promise<"skipped" | "done" | "asked" | "stop" | number> {
  const json = `${name}.json`;
  // A lock with no inbox file is one opened but never saved.
  const saved = existsSync(join(dir, json));
  if (!(saved ? stale(dir, json) : stale(dir, `${name}.lock`))) return "skipped";
  const lockedAt = mtime(dir, `${name}.lock`);
  const lockFile = join(dir, `${name}.lock`);
  const marker = join(dir, `${name}.sweep`);
  try {
    lock(lockFile, () => "in use", 1);
  } catch {
    return "skipped"; // In use.
  }
  try {
    if (deleteOnServer) {
      // Renamed into place, so no other sweep reads it empty.
      writeFileSync(`${marker}.${process.pid}.tmp`, String(process.pid));
      renameSync(`${marker}.${process.pid}.tmp`, marker);
    }
    // Opened and closed again while we were deciding?
    if (saved && !stale(dir, json)) return "skipped";
    if (!deleteOnServer) {
      if (saved) deleteFiles(dir, name);
      return "done";
    }
    if (!saved) {
      // An inbox the server may have, never saved here: saved empty, as old
      // as its lock, first, so it's still on record should this process be
      // cut short or the server not delete it.
      if (lockedAt === null) return "skipped";
      try {
        // Through its descriptor, so only this file is backdated, not one
        // `watch` puts in its place.
        const fd = openSync(join(dir, json), "wx");
        try {
          writeSync(fd, JSON.stringify(emptyState()));
          const t = new Date(lockedAt);
          futimesSync(fd, t, t);
        } finally {
          closeSync(fd);
        }
      } catch (e) {
        // `watch` saved it meanwhile.
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (!stale(dir, json)) return "skipped";
      }
    }
    const outcome = await deleteOnServer(name);
    if (!outcome.done) return "later" in outcome ? "asked" : outcome.retryAfter ?? "stop";
    // Used again, by `watch`, while the server was asked?
    if (stale(dir, json)) deleteFiles(dir, name);
    return "local" in outcome ? "done" : "asked";
  } finally {
    tryUnlink(marker);
    release(lockFile);
  }
}

// Deletes an inbox's file, and the write lock of a change that was killed.
function deleteFiles(dir: string, name: string): void {
  tryUnlink(join(dir, `${name}.json`));
  tryUnlink(join(dir, `${name}.writing`));
}

function pauseAsync(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms).unref());
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
// as another process's sweep() holds a reading lock only briefly (unless
// it's asking the server: see Inbox.openWaiting()). One left
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
