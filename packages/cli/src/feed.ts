import { matchesKind, type WatchEvent } from "@watcheroni/protocol";
import type { Inbox } from "./inbox.ts";
import { pollOnce, type Fetch } from "./poll.ts";
import type { ServerReader } from "./server.ts";
import { targetKey } from "./targets.ts";

// Where `wait`, `stream` and `exec` get events: the local inbox, filled by
// polling GitHub for the targets watched from this machine, and the
// server's inbox when there is a server. Each keeps its own numbering and
// is acknowledged separately.

interface Source {
  pending(): WatchEvent[];
  ack(seq: number): void;
}

export interface Item {
  event: WatchEvent;
  source: Source;
}

export interface FeedOptions {
  interval: number;
  log: (msg: string) => void;
  fetch?: Fetch;
}

export class Feed {
  private readonly inbox: Inbox;
  private readonly server: ServerReader | null;
  private readonly o: FeedOptions;
  private readonly hadTargets: boolean;
  private nextPoll = 0;

  constructor(inbox: Inbox, server: ServerReader | null, o: FeedOptions) {
    this.inbox = inbox;
    this.server = server;
    this.o = o;
    this.hadTargets = inbox.watched().length > 0;
  }

  // Pending events that match, acknowledging the rest so they don't wait
  // for ever.
  wanted(kinds: string[]): Item[] {
    this.check();
    const items: Item[] = [];
    for (const source of this.server ? [this.server, this.inbox] : [this.inbox]) {
      const pending = source.pending();
      if (source === this.server) {
        for (const e of pending) if (e.sub && e.kind.startsWith("watch.")) this.inbox.subscriptionEnded(e.sub, e.kind);
      }
      const keep = pending.filter((e) => matchesKind(kinds, e.kind));
      const skip = pending.filter((e) => !matchesKind(kinds, e.kind));
      // Acknowledge up to the first wanted event only, so the order holds.
      const firstKept = keep[0]?.seq ?? Infinity;
      const skippable = skip.filter((e) => e.seq < firstKept).map((e) => e.seq);
      if (skippable.length) source.ack(Math.max(...skippable));
      if (!keep.length && skip.length) source.ack(Math.max(...skip.map((e) => e.seq)));
      items.push(...keep.map((event) => ({ event, source })));
    }
    return items;
  }

  ack(items: Item[]): void {
    const last = new Map<Source, number>();
    for (const { event, source } of items) last.set(source, Math.max(last.get(source) ?? 0, event.seq));
    for (const [source, seq] of last) source.ack(seq);
  }

  // Polls GitHub for the targets watched from this machine. While the
  // server is unreachable that includes those it was watching.
  async poll(): Promise<void> {
    this.check();
    await pollOnce(this.inbox, this.o.log, this.o.fetch, !this.server?.connected);
    this.nextPoll = Date.now() + this.o.interval;
  }

  // Waits `ms`, collecting whatever arrives, then polls.
  async settle(ms: number): Promise<void> {
    await sleep(ms);
    await this.poll();
  }

  // Waits up to `ms` for something new: returns early when the server
  // sends events, and polls GitHub when a poll is due or the wait is over.
  async more(ms: number): Promise<void> {
    if (!this.server) {
      await sleep(ms);
      return this.poll();
    }
    const woke = await this.server.changed(Math.min(ms, Math.max(this.nextPoll - Date.now(), 0)));
    this.check();
    if (!woke || Date.now() >= this.nextPoll) await this.poll();
  }

  watching(): string[] {
    return this.inbox.watched().map((w) => targetKey(w.target));
  }

  // Whether everything watched has ended. Without a server, that's when
  // no PR is left. A server inbox may also be fed by subscriptions made
  // elsewhere, which can't be listed yet, so it ends only when this
  // command was watching PRs and they have all ended.
  ended(): boolean {
    if (this.inbox.watched().length) return false;
    return this.server ? this.hadTargets : true;
  }

  private check(): void {
    if (this.server?.failure) throw this.server.failure;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
