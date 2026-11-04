import { matchesKind, type WatchEvent } from "@watcheroni/protocol";
import { prKey, type Inbox } from "./inbox.ts";
import { pollOnce, type Fetch } from "./poll.ts";
import type { ServerReader } from "./server.ts";
import { repoKey, targetKey } from "./targets.ts";

// Where `wait`, `stream` and `exec` get events: the local inbox, filled by
// polling GitHub for the targets watched from this machine, and the
// server's inbox when there is a server. Each keeps its own numbering and
// is acknowledged separately.

interface Source {
  pending(): WatchEvent[];
  // Exactly these events are done with; any others stay pending, even
  // ones that came meanwhile.
  handled(events: WatchEvent[]): void;
}

export interface Item {
  event: WatchEvent;
  source: Source;
  // Unwanted events just before it, let go when it's acknowledged.
  passed: WatchEvent[];
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
  // Whether the server ended a repository-wide watch, for the footer.
  repoEnded = false;

  constructor(inbox: Inbox, server: ServerReader | null, o: FeedOptions) {
    this.inbox = inbox;
    this.server = server;
    this.o = o;
    this.hadTargets = inbox.watched().length + inbox.repoWatches().length > 0;
  }

  // Pending events that match both `kinds` and their PR's own kinds,
  // acknowledging the rest so they don't wait for ever.
  wanted(kinds: string[]): Item[] {
    this.check();
    // For what `watch` and `unwatch` have changed meanwhile.
    this.inbox.refresh();
    const items: Item[] = [];
    const left = new Set<string>();
    for (const source of this.server ? [this.server, this.inbox] : [this.inbox]) {
      const pending = source.pending();
      if (source === this.server) {
        for (const e of pending) {
          if (e.sub && e.kind.startsWith("watch.") && this.inbox.subscriptionEnded(e.sub, e.kind) === "repo") this.repoEnded = true;
        }
      }
      const want = (e: WatchEvent) => {
        if (source === this.server && e.sub && this.inbox.wasUnwatched(e.sub)) return false;
        const key = prKey(e);
        return wants(kinds, e) && (!key || wants(this.inbox.kindsFor(key), e));
      };
      // Unwanted events before the first wanted one are let go now; later
      // ones go with the wanted event after them, so the order holds, and
      // ones after the last wanted event wait. With nothing wanted, all go.
      let passed: WatchEvent[] = [];
      let first = true;
      for (const event of pending) {
        if (!want(event)) {
          passed.push(event);
          continue;
        }
        if (first) {
          if (passed.length) source.handled(passed);
          passed = [];
          first = false;
        }
        items.push({ event, source, passed });
        passed = [];
      }
      if (first && passed.length) source.handled(passed);
      // Unwanted events after the first wanted one are still pending.
      for (const e of source.pending()) left.add(prKey(e)?.toLowerCase() ?? "");
    }
    this.inbox.forgetEnded(left);
    return items;
  }

  // Acknowledges exactly these items, with the unwanted events before
  // each; whatever else came meanwhile stays pending.
  ack(items: Item[]): void {
    const done = new Map<Source, WatchEvent[]>();
    for (const { event, source, passed } of items) done.set(source, [...(done.get(source) ?? []), ...passed, event]);
    for (const [source, events] of done) source.handled(events);
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
    return [...this.inbox.watched().map((w) => targetKey(w.target)), ...this.inbox.repoWatches().map((r) => repoKey(r.target))];
  }

  // Whether everything watched has ended. Without a server, that's when
  // no PR is left. A server inbox may also be fed by subscriptions made
  // elsewhere, which can't be listed yet, so it ends only when this
  // command was watching PRs and they have all ended. A repository-wide
  // watch has no end of its own, but only the server feeds it: without
  // one it leaves nothing to wait for.
  ended(): boolean {
    if (this.inbox.watched().length || (this.server && this.inbox.repoWatches().length)) return false;
    return this.server ? this.hadTargets : true;
  }

  private check(): void {
    if (this.server?.failure) throw this.server.failure;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Whether `kinds` wants the event. A PR's `watch.ended` comes with its
// `pr.merged` or `pr.closed`, so kinds that leave those out aren't woken
// by the PR ending; the other `watch.*` kinds, and `repo.*` and `inbox.*`,
// always get through.
export function wants(kinds: string[], e: WatchEvent): boolean {
  const reason = e.data.reason;
  if (e.kind === "watch.ended" && kinds.length && (reason === "merged" || reason === "closed")) return matchesKind(kinds, `pr.${reason}`);
  return matchesKind(kinds, e.kind);
}
