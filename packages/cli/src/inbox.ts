import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { INBOX_NAME, type UnsequencedEvent, type WatchEvent } from "@watcheroni/protocol";
import type { Memory } from "./diff.ts";
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
  memory: Memory | null;
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
    return inbox;
  }

  // Reads an inbox without locking it, for `ls`.
  static peek(name: string): { watched: Watched[]; repos: RepoWatched[]; pending: number } {
    const inbox = new Inbox(name, join(stateDir(), "inboxes"));
    return { watched: inbox.watched(), repos: inbox.repoWatches(), pending: inbox.state.events.length };
  }

  close(): void {
    try {
      unlinkSync(this.lockFile);
    } catch {
      // Already gone.
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
    this.state.watched[key] = { target, addedAt: new Date().toISOString(), snapshot: null, memory: null, ...(sub ? { sub } : {}) };
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
  // here instead.
  subscriptionEnded(sub: string, kind: string): void {
    // A repository-wide watch can't be polled from here, so it's simply over.
    const repo = Object.entries(this.state.repos ?? {}).find(([, r]) => r.sub === sub);
    if (repo) {
      delete this.state.repos![repo[0]];
      this.save();
      return;
    }
    const entry = Object.entries(this.state.watched).find(([, w]) => w.sub === sub);
    if (!entry) return;
    const [key, w] = entry;
    if (kind === "watch.revoked" || kind === "watch.unverified" || kind === "watch.expired") delete w.sub;
    else delete this.state.watched[key];
    this.save();
  }

  update(key: string, snapshot: Snapshot, memory: Memory): void {
    const w = this.state.watched[key];
    if (w) Object.assign(w, { snapshot, memory });
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

function lock(file: string, name: string): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const pid = Number(readFileSync(file, "utf8"));
    if (pid && alive(pid)) {
      throw new InboxBusy(`Inbox ${name} is in use by process ${pid}, another wait, stream or exec; stop it, or use another inbox with --inbox`);
    }
    unlinkSync(file);
  }
  throw new InboxBusy(`Couldn't lock inbox ${name}`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
