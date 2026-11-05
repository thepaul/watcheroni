import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WatchEvent } from "@watcheroni/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Feed } from "../src/feed.ts";
import { formatText } from "../src/format.ts";
import { LoginNeeded } from "../src/github.ts";
import { Inbox } from "../src/inbox.ts";
import { type Credentials, type ServerCredentials, githubTokenFor } from "../src/login.ts";
import { MalformedAnswer, ServerClient, ServerError, ServerReader, Unreachable, renewSubscriptions, subscribe } from "../src/server.ts";
import type { Snapshot } from "../src/snapshot.ts";
import { targetKey } from "../src/targets.ts";
import { FakeServer } from "./fake-server.ts";
import { alice, snap } from "./fixtures.ts";

let fake: FakeServer;
let readers: ServerReader[] = [];
const messages: string[] = [];
// What readers took back (see ReaderOptions.takeBack).
const takenBack: WatchEvent[] = [];

beforeEach(async () => {
  process.env.WATCHERONI_STATE_DIR = mkdtempSync(join(tmpdir(), "watcheroni-test-"));
  fake = await new FakeServer().start();
  messages.length = 0;
  takenBack.length = 0;
});
afterEach(async () => {
  await Promise.all(readers.map((r) => r.close()));
  readers = [];
  await fake.stop();
});

function reader(name = "box", token = fake.token): ServerReader {
  const r = new ServerReader(new ServerClient({ url: fake.url, apiKey: token }), name, {
    log: (m) => messages.push(m),
    takeBack: (e) => void takenBack.push(...e),
    backoff: [20, 100],
  });
  readers.push(r);
  return r;
}

// Handles every pending event up to `seq`.
function handleThrough(r: ServerReader, seq: number): void {
  r.handled(r.pending().filter((e) => e.seq <= seq));
}

// Waits until `check` passes, or fails after a second.
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

describe("server reader", () => {
  it("reads over a WebSocket from the acknowledged position, and acknowledges", async () => {
    fake.inject("box", "comment.created");
    fake.inbox("box").acked = 1;
    fake.inject("box", "review.submitted");
    const r = reader();
    expect(await r.start()).toBe(true);
    expect(fake.messages[0]).toBe(JSON.stringify({ type: "hello" }));
    expect(await r.changed(1000)).toBe(true);
    expect(r.pending().map((e) => e.kind)).toEqual(["review.submitted"]);
    fake.inject("box", "check.failed");
    expect(await r.changed(1000)).toBe(true);
    expect(r.pending().map((e) => e.seq)).toEqual([2, 3]);
    handleThrough(r, 3);
    expect(r.pending()).toEqual([]);
    await until(() => fake.inbox("box").acked === 3);
    expect(fake.requests.filter((q) => q.includes("/ack"))).toEqual([]);
  });

  it("reconnects from where it was, dropping events seen before", async () => {
    const r = reader();
    await r.start();
    fake.inject("box", "a", {}, "id-a");
    await until(() => r.pending().length === 1);
    fake.closeSockets(1012, "restarting");
    await until(() => fake.messages.filter((m) => m.includes("hello")).length === 2 && r.connected);
    expect(fake.messages.filter((m) => m.includes("hello")).at(-1)).toBe(JSON.stringify({ type: "hello", after: 1 }));
    // The same event again under a new seq, as after a redelivery.
    fake.inject("box", "a", {}, "id-a");
    fake.inject("box", "b", {}, "id-b");
    await until(() => r.pending().length === 2);
    expect(r.pending().map((e) => e.id)).toEqual(["id-a", "id-b"]);
    expect(messages).toEqual([
      "lost the connection to " + fake.url + " (1012 restarting); reconnecting",
      "reconnected to " + fake.url,
    ]);
  });

  // An event as the server sends it, by seq, ID and kind.
  const event = (seq: number, id: string, kind = "x", data: WatchEvent["data"] = {}): WatchEvent => ({
    v: 1, seq, id, sub: null, kind, at: "t", received_at: "t", repo: null, pr: null, actor: null, data, links: {},
  });
  const send = (...events: WatchEvent[]) => {
    for (const s of fake.sockets) if (s.inbox === "box") s.send({ type: "events", events });
  };
  const gap = (missedAfter: number, resumedAt: number, id = `gap-${missedAfter}`) =>
    event(resumedAt - 1, id, "inbox.gap", { missed_after: missedAfter, resumed_at: resumedAt });

  it("moves back to an inbox.gap for a position ahead of the inbox's head, handing over what it holds", async () => {
    const r = reader();
    await r.start();
    for (const kind of ["a", "b", "c"]) fake.inject("box", kind);
    await until(() => r.pending().length === 3);
    handleThrough(r, 2);
    await until(() => fake.inbox("box").acked === 2);
    // The server had no record of seq 3: it answers with a gap from it,
    // and the events it keeps, all lower. c, received but not handled,
    // is handed over to be kept elsewhere: its seq means nothing now.
    send(gap(3, 1), event(1, "again-1"));
    await until(() => r.pending().length === 2);
    expect(takenBack.map((e) => [e.seq, e.kind])).toEqual([[3, "c"]]);
    expect(r.pending().map((e) => [e.seq, e.kind])).toEqual([[0, "inbox.gap"], [1, "x"]]);
    expect(formatText(r.pending().slice(0, 1), [])).toContain("inbox.gap: the server didn't recognise the position read up to");
    // From there it reads on as usual; a stale gap for an old position doesn't move it.
    send(gap(3, 1), event(2, "again-2"));
    await until(() => r.pending().length === 3);
    expect(r.pending().map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(takenBack).toHaveLength(1);
    handleThrough(r, 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.messages.filter((m) => m.includes('"ack"')).at(-1)).toBe(JSON.stringify({ type: "ack", seq: 2 }));
  });

  for (const longPoll of [false, true]) {
    it(`acknowledges nothing of an inbox whose numbering went back till its gap is read, ${longPoll ? "long-polling" : "over a WebSocket"}`, async () => {
      fake.refuseSockets = longPoll;
      fake.aheadGaps = true;
      // A server that takes an ack past head as head, as older ones did.
      fake.clampAcks = true;
      const r = reader();
      await r.start();
      for (const kind of ["a", "b", "c"]) fake.inject("box", kind);
      await until(() => r.pending().length === 3);
      handleThrough(r, 3);
      await until(() => fake.inbox("box").acked === 3);
      // The inbox starts again, and has x and y before this reader is back.
      Object.assign(fake.inbox("box"), { head: 0, acked: 0, events: [] });
      fake.inject("box", "x", {}, "new-x");
      fake.inject("box", "y", {}, "new-y");
      if (!longPoll) fake.closeSockets(1012, "restarting");
      await until(() => r.pending().length === 3);
      expect(r.pending().map((e) => [e.seq, e.kind])).toEqual([[0, "inbox.gap"], [1, "x"], [2, "y"]]);
      // Position 3 would be taken as head (2), acknowledging x and y unread.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fake.inbox("box").acked).toBe(0);
      handleThrough(r, 2);
      await until(() => fake.inbox("box").acked === 2);
    });
  }

  it("keeps events that come while one is being handled, below it or not", async () => {
    const r = reader();
    await r.start();
    for (const kind of ["a", "b", "c"]) fake.inject("box", kind);
    await until(() => r.pending().length === 3);
    handleThrough(r, 2);
    // c is being handled (a command running for it, say) when a gap that
    // moves the position back, and a new event, come.
    const [c] = r.pending();
    send(gap(3, 1), event(1, "new-1"));
    await until(() => r.pending().length === 2);
    r.handled([c]);
    expect(r.pending().map((e) => [e.seq, e.id])).toEqual([[0, "gap-3"], [1, "new-1"]]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.inbox("box").acked).toBe(2);

    // An event out of order, below one being handled, stays too.
    const r2 = reader("box2");
    const send2 = (...events: WatchEvent[]) => {
      for (const s of fake.sockets) if (s.inbox === "box2") s.send({ type: "events", events });
    };
    await r2.start();
    send2(event(8, "e8"));
    await until(() => r2.pending().length === 1);
    const [e8] = r2.pending();
    send2(event(5, "e5"));
    await until(() => r2.pending().length === 2);
    r2.handled([e8]);
    expect(r2.pending().map((e) => e.id)).toEqual(["e5"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.inbox("box2").acked).toBeLessThan(5);
  });

  it("keeps an event whose seq goes back, in order, warning of it once a batch, but drops a repeated one quietly", async () => {
    const r = reader();
    await r.start();
    send(event(7, "a"), event(6, "b"));
    await until(() => r.pending().length === 2);
    expect(r.pending().map((e) => [e.seq, e.id])).toEqual([[6, "b"], [7, "a"]]);
    const report = "if this keeps happening, report it to the server's operator";
    expect(messages).toEqual([`${fake.url} sent an event out of order (seq 6 after 7); it's shown anyway; ${report}`]);
    // One already seen, again under a lower seq, as a redelivery can be.
    send(event(5, "a"), event(8, "c"));
    await until(() => r.pending().length === 3);
    expect(r.pending().map((e) => e.id)).toEqual(["b", "a", "c"]);
    expect(messages).toHaveLength(1);
    // Several in one batch: one warning.
    send(event(2, "d"), event(4, "e"), event(3, "f"));
    await until(() => r.pending().length === 6);
    expect(r.pending().map((e) => e.id)).toEqual(["d", "f", "e", "b", "a", "c"]);
    expect(messages.slice(1)).toEqual([`${fake.url} sent 3 events out of order (seqs 2 to 4 after 8); they're shown anyway; ${report}`]);
  });

  it("doesn't acknowledge a malformed event from before a gap that moves it back", async () => {
    const r = reader();
    await r.start();
    fake.inject("box", "a");
    fake.injectMalformed("box", { kind: 42 });
    await until(() => r.pending().length === 1 && messages.length === 1);
    // The skipped seq 2 was from the inbox's earlier life: acknowledging
    // what comes after the gap mustn't acknowledge it.
    send(gap(2, 1, "gap"), event(1, "new-x"));
    await until(() => r.pending().length === 2);
    expect(takenBack.map((e) => e.kind)).toEqual(["a"]);
    r.handled(r.pending());
    await until(() => fake.inbox("box").acked === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.inbox("box").acked).toBe(1);
  });

  it("moves back to an inbox.gap for a position ahead of head when long-polling too", async () => {
    fake.refuseSockets = true;
    fake.aheadGaps = true;
    const r = reader();
    await r.start();
    for (const kind of ["a", "b", "c"]) fake.inject("box", kind);
    await until(() => r.pending().length === 3);
    // The inbox starts again from nothing, as one made again used to.
    Object.assign(fake.inbox("box"), { head: 0, acked: 0, events: [] });
    fake.inject("box", "x", {}, "new-x");
    await until(() => r.pending().length === 2);
    expect(takenBack.map((e) => [e.seq, e.kind])).toEqual([[1, "a"], [2, "b"], [3, "c"]]);
    expect(r.pending().map((e) => [e.seq, e.kind])).toEqual([[0, "inbox.gap"], [1, "x"]]);
    expect(r.pending()[0].data).toEqual({ missed_after: 3, resumed_at: 1 });
    // The next poll is from there, and gets what follows.
    fake.inject("box", "y", {}, "new-y");
    await until(() => r.pending().length === 3);
    expect(r.pending().map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(fake.requests).toContain("GET /v1/inboxes/box/events?wait=300&after=1");
  });

  it("stops when the key is revoked", async () => {
    const r = reader();
    await r.start();
    fake.closeSockets(4001, "key revoked");
    expect(await r.changed(1000)).toBe(true);
    expect(r.failure).toBeInstanceOf(LoginNeeded);
  });

  it("rejects a wrong key", async () => {
    await expect(reader("box", "wrong").start()).rejects.toBeInstanceOf(LoginNeeded);
  });

  it("long-polls when no WebSocket can be opened", async () => {
    fake.refuseSockets = true;
    const r = reader();
    expect(await r.start()).toBe(true);
    expect(messages).toEqual([`couldn't open a WebSocket to ${fake.url}; long-polling instead`]);
    fake.inject("box", "comment.created");
    expect(await r.changed(1000)).toBe(true);
    expect(r.pending().map((e) => e.kind)).toEqual(["comment.created"]);
    expect(fake.requests).toContain("GET /v1/inboxes/box/events?wait=0");
    expect(fake.requests).toContain("GET /v1/inboxes/box/events?wait=300&after=0");
    handleThrough(r, 1);
    await until(() => fake.inbox("box").acked === 1);
    // The next poll starts after what it has.
    await until(() => fake.requests.includes("GET /v1/inboxes/box/events?wait=300&after=1"));
  });

  it("long-polls when the account has too many WebSockets", async () => {
    fake.tooManySockets = true;
    const r = reader();
    expect(await r.start()).toBe(true);
    expect(messages).toEqual([`${fake.url} has too many connections for this account; long-polling instead`]);
    fake.inject("box", "comment.created");
    expect(await r.changed(1000)).toBe(true);
    expect(r.pending().map((e) => e.kind)).toEqual(["comment.created"]);
  });

  it("asks less often when the account has too many long polls waiting", async () => {
    fake.refuseSockets = true;
    fake.tooManyPolls = true;
    const r = reader();
    expect(await r.start()).toBe(true);
    await until(() => fake.requests.filter((q) => q.includes("wait=300")).length === 1);
    expect(messages.at(-1)).toBe(`${fake.url} has too many long polls waiting for this account; asking every 1 s instead`);
    expect(r.connected).toBe(true);
    // Events still come, on the next ask.
    fake.inject("box", "comment.created");
    fake.tooManyPolls = false;
    expect(await r.changed(2000)).toBe(true);
    expect(r.pending().map((e) => e.kind)).toEqual(["comment.created"]);
    expect(fake.requests.filter((q) => q.includes("wait=300"))).toHaveLength(2);
    expect(messages.filter((m) => m.includes("too many long polls"))).toHaveLength(1);
  });

  it("says when the account has too many inboxes", async () => {
    fake.tooManyInboxes = true;
    const client = new ServerClient({ url: fake.url, apiKey: fake.token });
    const err = await client.ensureInbox("box").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerError);
    expect((err as ServerError).message).toBe(`${fake.url}: PUT /v1/inboxes/box: 422 Too many inboxes on this account (at most 500)`);
  });

  it("keeps trying while the server is down", async () => {
    const port = fake.port;
    await fake.stop();
    const r = reader();
    expect(await r.start()).toBe(false);
    fake = await new FakeServer().start(port);
    fake.inject("box", "comment.created");
    await until(() => r.connected);
    expect(await r.changed(1000)).toBe(true);
    expect(r.pending()).toHaveLength(1);
    expect(messages).toEqual([`connected to ${fake.url}`]);
  });
});

describe("feed", () => {
  const target = { owner: "octo", name: "widgets", number: 7 };

  it("merges server events with PRs polled from this machine, and acknowledges each", async () => {
    const inbox = Inbox.open("feed1");
    inbox.watch(targetKey(target), target);
    const snapshots: Snapshot[] = [
      snap(),
      snap({ comments: [{ id: 1, at: "t", url: "u", author: alice }] }),
      snap({ state: "MERGED", mergeSha: "m".repeat(40), comments: [{ id: 1, at: "t", url: "u", author: alice }] }),
    ];
    const r = reader("feed1");
    await r.start();
    const feed = new Feed(inbox, r, { interval: 60_000, log: () => {}, fetch: async () => snapshots.shift()! });
    await feed.poll();
    expect(feed.wanted([])).toEqual([]);

    // A server event wakes it before the next poll is due.
    const started = Date.now();
    fake.inject("feed1", "review.submitted");
    await feed.more(60_000);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(feed.wanted([]).map((i) => i.event.kind)).toEqual(["review.submitted"]);
    expect(snapshots).toHaveLength(2);

    // A wait that runs out polls GitHub.
    await feed.more(10);
    const items = feed.wanted([]);
    expect(items.map((i) => i.event.kind)).toEqual(["review.submitted", "comment.created"]);
    feed.ack(items);
    expect(feed.wanted([])).toEqual([]);
    await until(() => fake.inbox("feed1").acked === 1);
    expect(feed.ended()).toBe(false);

    await feed.more(10);
    expect(feed.wanted([]).map((i) => i.event.kind)).toEqual(["pr.merged", "watch.ended"]);
    expect(feed.ended()).toBe(true);
    inbox.close();
  });

  it("keeps reading a server inbox that watches no PR known here", async () => {
    const inbox = Inbox.open("feed2");
    const r = reader("feed2");
    await r.start();
    const feed = new Feed(inbox, r, { interval: 60_000, log: () => {} });
    expect(feed.ended()).toBe(false);
    expect(new Feed(inbox, null, { interval: 60_000, log: () => {} }).ended()).toBe(true);
    inbox.close();
  });

  // A reader that keeps what it takes back in `inbox`, as main.ts has it.
  const keeping = (name: string, inbox: Inbox) => {
    const r = new ServerReader(new ServerClient({ url: fake.url, apiKey: fake.token }), name, {
      log: (m) => messages.push(m),
      takeBack: (events) => inbox.hold(events),
      backoff: [20, 100],
    });
    readers.push(r);
    return r;
  };
  const sendTo = (name: string, events: WatchEvent[]) => {
    for (const s of fake.sockets) if (s.inbox === name) s.send({ type: "events", events });
  };
  const serverEvent = (seq: number, id: string, kind: string, data: WatchEvent["data"] = {}): WatchEvent => ({
    v: 1, seq, id, sub: null, kind, at: "t", received_at: "t", repo: null, pr: null, actor: null, data, links: {},
  });

  it("acknowledges what it shows, and the unwanted events before each, but not what came meanwhile", async () => {
    const inbox = Inbox.open("feed10");
    const r = keeping("feed10", inbox);
    await r.start();
    fake.inject("feed10", "check.failed");
    fake.inject("feed10", "comment.created");
    fake.inject("feed10", "check.failed");
    fake.inject("feed10", "comment.created");
    await until(() => r.pending().length === 4);
    const feed = new Feed(inbox, r, { interval: 60_000, log: () => {} });
    const items = feed.wanted(["check.*"]);
    expect(items.map((i) => i.event.seq)).toEqual([1, 3]);
    // While they're shown, an event out of order comes.
    sendTo("feed10", [serverEvent(2, "late", "check.failed")]);
    await until(() => r.pending().length === 5);
    feed.ack(items);
    // The comment between them goes with the second; the one after it,
    // and what came meanwhile, wait.
    expect(r.pending().map((e) => [e.seq, e.kind])).toEqual([[2, "check.failed"], [4, "comment.created"]]);
    await until(() => fake.inbox("feed10").acked === 1);
    inbox.close();
  });

  it("shows again what a gap took back while it was being shown, rather than lose it", async () => {
    const inbox = Inbox.open("feed8");
    const r = keeping("feed8", inbox);
    await r.start();
    fake.inject("feed8", "check.failed");
    fake.inject("feed8", "comment.created");
    fake.inject("feed8", "check.failed");
    fake.inject("feed8", "comment.created");
    await until(() => r.pending().length === 4);
    const feed = new Feed(inbox, r, { interval: 60_000, log: () => {} });
    const items = feed.wanted(["check.*"]);
    expect(items.map((i) => i.event.seq)).toEqual([1, 3]);
    // While they're shown (`wait`, or a command `exec` runs for them),
    // the inbox is made again, and the server moves the position back:
    // what was pending is kept in the local inbox.
    sendTo("feed8", [serverEvent(0, "gap", "inbox.gap", { missed_after: 4, resumed_at: 1 }), serverEvent(1, "new", "check.failed")]);
    await until(() => r.pending().length === 2);
    expect(inbox.pending().map((e) => e.kind)).toEqual(["check.failed", "comment.created", "check.failed", "comment.created"]);
    // Acknowledging what was shown can't reach the copies kept now, which
    // are shown again: twice, but never lost.
    feed.ack(items);
    expect(inbox.pending()).toHaveLength(4);
    expect(feed.wanted(["check.*"]).map((i) => i.event.kind)).toEqual(["check.failed", "check.failed", "inbox.gap", "check.failed"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.inbox("feed8").acked).toBe(0);
    inbox.close();
  });

  it("shows what a gap took back first, even after the process ends, and an event out of order after it", async () => {
    const inbox = Inbox.open("feed9");
    const r = keeping("feed9", inbox);
    await r.start();
    for (const kind of ["a", "b", "c"]) fake.inject("feed9", kind);
    await until(() => r.pending().length === 3);
    const feed = new Feed(inbox, r, { interval: 60_000, log: () => {} });
    feed.ack(feed.wanted([]).slice(0, 1));
    await until(() => fake.inbox("feed9").acked === 1);
    sendTo("feed9", [serverEvent(0, "gap", "inbox.gap", { missed_after: 3, resumed_at: 1 }), serverEvent(1, "x", "x")]);
    await until(() => r.pending().length === 2);
    // Late, below the position.
    sendTo("feed9", [serverEvent(0, "late", "late")]);
    await until(() => r.pending().length === 3);
    expect(feed.wanted([]).map((i) => i.event.kind)).toEqual(["b", "c", "inbox.gap", "late", "x"]);
    // The process ends before showing anything.
    await r.close();
    inbox.close();
    const again = Inbox.open("feed9");
    expect(new Feed(again, null, { interval: 60_000, log: () => {} }).wanted([]).map((i) => i.event.kind)).toEqual(["b", "c"]);
    // None of it was acknowledged on the server.
    expect(fake.inbox("feed9").acked).toBe(1);
    again.close();
  });

  it("acknowledges unwanted kinds up to the first wanted one", async () => {
    const inbox = Inbox.open("feed3");
    const r = reader("feed3");
    await r.start();
    fake.inject("feed3", "comment.created");
    fake.inject("feed3", "check.failed");
    fake.inject("feed3", "comment.created");
    await until(() => r.pending().length === 3);
    const feed = new Feed(inbox, r, { interval: 60_000, log: () => {} });
    expect(feed.wanted(["check.*"]).map((i) => i.event.seq)).toEqual([2]);
    await until(() => fake.inbox("feed3").acked === 1);
    inbox.close();
  });

  it("filters a server-watched PR by its own kinds, and lets its end go when they leave it out", async () => {
    const inbox = Inbox.open("feed4");
    inbox.watch(targetKey(target), target, "sub_9", ["check.failed"]);
    const r = reader("feed4");
    await r.start();
    fake.inject("feed4", "comment.created", {}, "e1", "sub_9");
    fake.inject("feed4", "check.failed", {}, "e2", "sub_9");
    fake.inject("feed4", "pr.merged", {}, "e3", "sub_9");
    fake.inject("feed4", "watch.ended", { reason: "merged" }, "e4", "sub_9");
    await until(() => r.pending().length === 4);
    const feed = new Feed(inbox, r, { interval: 60_000, log: () => {} });
    const items = feed.wanted([]);
    expect(items.map((i) => i.event.kind)).toEqual(["check.failed"]);
    expect(inbox.watched()).toEqual([]);
    feed.ack(items);
    expect(feed.wanted([])).toEqual([]);
    expect(inbox.kindsFor(targetKey(target))).toEqual([]);
    expect(feed.ended()).toBe(true);
    inbox.close();
  });

  it("keeps a PR's kinds when the server lets its watch expire, polling it from here instead", async () => {
    const inbox = Inbox.open("feed6");
    inbox.watch(targetKey(target), target, "sub_9", ["check.failed"]);
    const r = reader("feed6");
    await r.start();
    fake.inject("feed6", "watch.expired", { reason: "unread" }, "e1", "sub_9");
    await until(() => r.pending().length === 1);
    const feed = new Feed(inbox, r, { interval: 60_000, log: () => {} });
    expect(feed.wanted([]).map((i) => i.event.kind)).toEqual(["watch.expired"]);
    expect(inbox.watched().map((w) => [w.sub, w.kinds])).toEqual([[undefined, ["check.failed"]]]);
    inbox.close();
  });

  it("drops events a PR's subscription queued before the PR was unwatched", async () => {
    const inbox = Inbox.open("feed7");
    inbox.watch(targetKey(target), target, "sub_9");
    inbox.unwatch(targetKey(target));
    const r = reader("feed7");
    await r.start();
    fake.inject("feed7", "comment.created", {}, "e1", "sub_9");
    fake.inject("feed7", "comment.created", {}, "e2", "sub_other");
    await until(() => r.pending().length === 2);
    const feed = new Feed(inbox, r, { interval: 60_000, log: () => {} });
    expect(feed.wanted([]).map((i) => i.event.id)).toEqual(["e2"]);
    await until(() => fake.inbox("feed7").acked === 1);
    inbox.close();
  });

  it("lets a PR's end through a run's kinds only with pr.merged or pr.closed", async () => {
    const inbox = Inbox.open("feed5");
    const r = reader("feed5");
    await r.start();
    fake.inject("feed5", "watch.ended", { reason: "merged" });
    fake.inject("feed5", "watch.expired", { reason: "unread" });
    await until(() => r.pending().length === 2);
    const feed = new Feed(inbox, r, { interval: 60_000, log: () => {} });
    expect(feed.wanted(["check.*"]).map((i) => i.event.kind)).toEqual(["watch.expired"]);
    expect(feed.wanted(["pr.merged"]).map((i) => i.event.kind)).toEqual(["watch.expired"]);
    inbox.close();
  });

  it("lets repo.* and inbox.* through any kinds", async () => {
    const inbox = Inbox.open("feed8");
    const r = reader("feed8");
    await r.start();
    fake.inject("feed8", "inbox.gap", { missed_after: 0, resumed_at: 2 }, "e1", null, null);
    fake.inject("feed8", "comment.created", {}, "e2", "sub_9");
    fake.inject("feed8", "repo.throttled", { until: "t" }, "e3", "sub_9", null);
    fake.inject("feed8", "repo.unthrottled", { dropped: 1 }, "e4", "sub_9", null);
    await until(() => r.pending().length === 4);
    const feed = new Feed(inbox, r, { interval: 60_000, log: () => {} });
    expect(feed.wanted(["check.*"]).map((i) => i.event.kind)).toEqual(["inbox.gap", "repo.throttled", "repo.unthrottled"]);
    inbox.close();
  });
});

describe("subscribing on the server", () => {
  const pub = { owner: "octo", name: "widgets", number: 7 };
  const priv = { owner: "octo", name: "secret", number: 3 };
  const client = () => new ServerClient({ url: fake.url, apiKey: fake.token });
  const log = (m: string) => void messages.push(m);

  // Credentials as `watcheroni login` leaves them, for this fake server.
  function signIn(github: Partial<ServerCredentials["github"]>): string {
    const path = join(mkdtempSync(join(tmpdir(), "watcheroni-cred-")), "credentials.json");
    process.env.WATCHERONI_CREDENTIALS = path;
    const entry: ServerCredentials = {
      api_key: fake.token,
      key_id: "key_1",
      account: { id: 7, login: "octocat" },
      github: { access_token: "ghu_old", refresh_token: "ghr_old", expires_at: null, refresh_token_expires_at: null, ...github },
    };
    writeFileSync(path, JSON.stringify({ servers: { [fake.url]: entry } }));
    return path;
  }
  afterEach(() => {
    delete process.env.WATCHERONI_CREDENTIALS;
  });

  it("subscribes a public repo's PR without sending a GitHub token", async () => {
    fake.repos.set("octo/widgets", { private: false });
    signIn({});
    expect(await subscribe(client(), "box", pub, { log, githubToken: () => githubTokenFor(fake.url) })).toBe("sub_1");
    expect(fake.subscriptions).toEqual([{ id: "sub_1", inbox: "box", repo: "octo/widgets", pr: 7, githubToken: null }]);
    expect(messages).toEqual([]);
  });

  it("sends the saved GitHub token only when the repo turns out to be private", async () => {
    fake.repos.set("octo/secret", { private: true });
    fake.githubTokens.add("ghu_old");
    signIn({ expires_at: new Date(Date.now() + 3600_000).toISOString() });
    expect(await subscribe(client(), "box", priv, { log, githubToken: () => githubTokenFor(fake.url) })).toBe("sub_1");
    expect(fake.subscriptions.map((s) => s.githubToken)).toEqual(["ghu_old"]);
    expect(fake.requests.filter((r) => r.includes("/subscriptions"))).toHaveLength(2);
    expect(fake.refreshed).toEqual([]);
  });

  it("refreshes an expired GitHub token through the server first, and saves it", async () => {
    fake.repos.set("octo/secret", { private: true });
    fake.githubTokens.add("ghu_new");
    fake.refreshAnswer = { access_token: "ghu_new", expires_in: 28800, refresh_token: "ghr_new", refresh_token_expires_in: 15897600 };
    const path = signIn({ expires_at: new Date(Date.now() - 1000).toISOString() });
    expect(await subscribe(client(), "box", priv, { log, githubToken: () => githubTokenFor(fake.url) })).toBe("sub_1");
    expect(fake.refreshed).toEqual(["ghr_old"]);
    expect(fake.subscriptions.map((s) => s.githubToken)).toEqual(["ghu_new"]);
    const saved = (JSON.parse(readFileSync(path, "utf8")) as Credentials).servers[fake.url].github;
    expect(saved.access_token).toBe("ghu_new");
    expect(saved.refresh_token).toBe("ghr_new");
    expect(Date.parse(saved.expires_at!)).toBeGreaterThan(Date.now() + 7 * 3600_000);
  });

  it("falls back to polling when the token can't be refreshed or isn't accepted", async () => {
    fake.repos.set("octo/secret", { private: true });
    signIn({ expires_at: new Date(Date.now() - 1000).toISOString() });
    expect(await subscribe(client(), "box", priv, { log, githubToken: () => githubTokenFor(fake.url) })).toBeNull();
    expect(messages.at(-1)).toMatch(/there's no GitHub token .* run `watcheroni login`/);

    signIn({});
    expect(await subscribe(client(), "box", priv, { log, githubToken: () => githubTokenFor(fake.url) })).toBeNull();
    expect(messages.at(-1)).toMatch(/didn't accept this machine's GitHub token/);
    expect(fake.subscriptions).toEqual([]);
  });

  it("says the server is limiting refreshes, not to sign in again, on a 429", async () => {
    fake.repos.set("octo/secret", { private: true });
    fake.refreshLimited = true;
    const path = signIn({ expires_at: new Date(Date.now() - 1000).toISOString() });
    expect(await subscribe(client(), "box", priv, { log, githubToken: () => githubTokenFor(fake.url) })).toBeNull();
    expect(messages.at(-1)).toBe(
      `couldn't subscribe to octo/secret#3 (${fake.url} is limiting GitHub token refreshes from this address; try again in 60 seconds)`,
    );
    expect(messages.join("\n")).not.toMatch(/watcheroni login/);
    // The refresh token wasn't used up, so it's kept for next time.
    expect((JSON.parse(readFileSync(path, "utf8")) as Credentials).servers[fake.url].github.refresh_token).toBe("ghr_old");

    // Renewing logs the same, and leaves the subscription for next time.
    fake.refreshLimited = false;
    fake.githubTokens.add("ghu_old");
    signIn({ expires_at: new Date(Date.now() + 3600_000).toISOString() });
    const sub = await subscribe(client(), "box", priv, { log, githubToken: () => githubTokenFor(fake.url) });
    fake.verifiedUntil.set(sub!, new Date(Date.now() + 3600_000).toISOString());
    fake.refreshLimited = true;
    signIn({ expires_at: new Date(Date.now() - 1000).toISOString() });
    messages.length = 0;
    await renewSubscriptions(client(), "box", { log, githubToken: () => githubTokenFor(fake.url) });
    expect(messages).toEqual([
      `couldn't renew the server's watch on octo/secret: ${fake.url} is limiting GitHub token refreshes from this address; try again in 60 seconds`,
    ]);
    expect(fake.verified).toEqual([]);
  });

  it("says the server can't be reached, not to sign in again, when a refresh gets no answer", async () => {
    signIn({ expires_at: new Date(Date.now() - 1000).toISOString() });
    const down = async () => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
    };
    const refreshing = githubTokenFor(fake.url, { fetch: down, now: Date.now });
    await expect(refreshing).rejects.toThrow(Unreachable);
    await expect(refreshing).rejects.toThrow(`can't reach ${fake.url} to refresh the GitHub token: connect ECONNREFUSED`);
  });

  it("renews private subscriptions due within two days, and only those", async () => {
    fake.repos.set("octo/secret", { private: true });
    fake.repos.set("octo/widgets", { private: false });
    fake.githubTokens.add("ghu_old");
    signIn({ expires_at: new Date(Date.now() + 3600_000).toISOString() });
    const token = { log, githubToken: () => githubTokenFor(fake.url) };
    const soon = await subscribe(client(), "box", priv, token);
    const later = await subscribe(client(), "box", { ...priv, number: 8 }, token);
    await subscribe(client(), "box", pub, token);
    fake.verifiedUntil.set(soon!, new Date(Date.now() + 3600_000).toISOString());
    fake.verifiedUntil.set(later!, new Date(Date.now() + 6 * 24 * 3600_000).toISOString());
    await renewSubscriptions(client(), "box", token);
    expect(fake.verified).toEqual([{ id: soon, githubToken: "ghu_old" }]);
    expect(messages).toEqual([]);

    // With no token to show, it says what to do.
    fake.verifiedUntil.set(later!, new Date(Date.now() + 3600_000).toISOString());
    await renewSubscriptions(client(), "box", { log });
    expect(messages).toEqual(["the server needs a fresh GitHub token to keep watching octo/secret; run `watcheroni login`"]);
  });

  it("falls back to polling when the App isn't installed, saying where to install it", async () => {
    expect(await subscribe(client(), "box", pub, { log })).toBeNull();
    expect(messages).toEqual(["the watcheroni App isn't installed on octo/widgets; it can be installed from https://github.com/apps/watcheroni/installations/new"]);
  });

  it("leaves out an install address that isn't a github.com page", async () => {
    fake.installUrl = "https://github.com.evil.com/apps/watcheroni\n\x1b[2Jrun this";
    expect(await subscribe(client(), "box", pub, { log })).toBeNull();
    expect(messages).toEqual(["the watcheroni App isn't installed on octo/widgets"]);
  });

  it("falls back to polling when the server is down", async () => {
    await fake.stop();
    expect(await subscribe(client(), "box", pub, { log })).toBeNull();
    expect(messages[0]).toMatch(/^couldn't subscribe to octo\/widgets#7/);
  });

  it("stops watching a PR when the server ends its subscription, or polls it when revoked", async () => {
    const inbox = Inbox.open("ending");
    inbox.watch(targetKey(pub), pub, "sub_a");
    inbox.watch(targetKey(priv), priv, "sub_b");
    const r = reader("ending");
    await r.start();
    const polled: string[] = [];
    const feed = new Feed(inbox, r, {
      interval: 60_000,
      log: () => {},
      fetch: async (t) => (polled.push(targetKey(t)), snap()),
    });
    fake.inject("ending", "watch.revoked", { reason: "uninstalled" }, "e1", "sub_b");
    await until(() => r.pending().length === 1);
    feed.wanted([]);
    expect(inbox.watched().map((w) => [targetKey(w.target), w.sub ?? null])).toEqual([["octo/widgets#7", "sub_a"], ["octo/secret#3", null]]);
    await feed.poll();
    expect(polled).toEqual(["octo/secret#3"]);

    fake.inject("ending", "watch.ended", { reason: "merged" }, "e2", "sub_a");
    await until(() => r.pending().length === 2);
    feed.wanted([]);
    expect(inbox.watched().map((w) => targetKey(w.target))).toEqual(["octo/secret#3"]);
    inbox.close();
  });
});

describe("a malformed event", () => {
  const shapes: Record<string, unknown>[] = [
    { kind: 42 }, { kind: null }, { id: null }, { id: 7 }, { data: null }, { data: [] }, { data: "x" },
    { repo: "octo/widgets" }, { repo: { id: 1, full_name: 1 } }, { pr: "7" }, { links: null }, { sub: 5 }, { actor: "x" },
  ];

  for (const longPoll of [false, true]) {
    it(`is skipped with a warning and acknowledged, and later ones still come, ${longPoll ? "long-polling" : "over a WebSocket"}`, async () => {
      fake.refuseSockets = longPoll;
      const r = reader();
      await r.start();
      messages.length = 0;
      for (const [i, shape] of shapes.entries()) {
        // A fresh seq, so a bad one in `shape` replaces a sound one.
        const seq = fake.inbox("box").head + 1;
        fake.injectMalformed("box", { id: "\x1b[31mbad", kind: "check.failed", ...shape });
        await until(() => fake.inbox("box").acked === seq);
        // What's sound of it is named.
        const parts = [
          "kind" in shape ? null : `kind "check.failed"`,
          "repo" in shape ? null : "pr" in shape ? "octo/widgets" : "octo/widgets#7",
          `seq ${seq}`,
          "id" in shape ? null : `id "[31mbad"`,
        ].filter(Boolean).join(", ");
        expect(messages[i]).toBe(
          `dropped a malformed event from ${fake.url} (${parts}): it isn't shaped as the protocol says, so it's acknowledged unshown; if this keeps happening, report it to the server's operator`,
        );
        const good = fake.inject("box", "comment.created");
        await until(() => r.pending().length === 1);
        expect(r.pending()[0].id).toBe(good.id);
        handleThrough(r, good.seq);
        await until(() => fake.inbox("box").acked === good.seq);
      }
      expect(messages).toHaveLength(shapes.length);
    });
  }

  it("waits for what comes before it to be read, and can't be placed without a sound seq", async () => {
    const r = reader();
    await r.start();
    const first = fake.inject("box", "comment.created");
    fake.injectMalformed("box", { kind: 42 });
    await until(() => messages.length === 1 && r.pending().length === 1);
    expect(fake.inbox("box").acked).toBe(0);
    // Reading the first acknowledges the skipped one too.
    handleThrough(r, first.seq);
    await until(() => fake.inbox("box").acked === 2);

    fake.injectMalformed("box", { seq: 2.5 });
    await until(() => messages.length === 2);
    expect(messages[1]).toMatch(/ \(kind "debug\.ping", octo\/widgets#7, id "fake:[^"]*"\): it isn't shaped as the protocol says; if this keeps/);
    const next = fake.inject("box", "comment.created");
    await until(() => r.pending().length === 1);
    handleThrough(r, next.seq);
    await until(() => fake.inbox("box").acked === next.seq);
  });

  it("is acknowledged only with the last event before it", async () => {
    fake.inbox("box").head = fake.inbox("box").acked = 4;
    const r = reader();
    await r.start();
    fake.inject("box", "comment.created");
    fake.inject("box", "comment.created");
    fake.injectMalformed("box", { kind: 42 });
    await until(() => r.pending().length === 2 && messages.length === 1);
    handleThrough(r, 5);
    await until(() => fake.inbox("box").acked === 5);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.inbox("box").acked).toBe(5);
    handleThrough(r, 6);
    await until(() => fake.inbox("box").acked === 7);
  });

  it("is warned of at or below the position too, though not acknowledged", async () => {
    const r = reader();
    await r.start();
    fake.inject("box", "a");
    fake.inject("box", "b");
    await until(() => r.pending().length === 2);
    const bad = { v: 1, seq: 1, id: "bad", sub: null, kind: 42, at: "t", received_at: "t", repo: null, pr: null, actor: null, data: {}, links: {} };
    for (const s of fake.sockets) s.send(JSON.stringify({ type: "events", events: [bad] }));
    await until(() => messages.length === 1);
    expect(messages[0]).toBe(
      `dropped a malformed event from ${fake.url} (seq 1, id "bad"): it isn't shaped as the protocol says; if this keeps happening, report it to the server's operator`,
    );
    handleThrough(r, 1);
    await until(() => fake.inbox("box").acked === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.inbox("box").acked).toBe(1);
  });

  it("isn't one for a missing nullable field, or a seq of 0", async () => {
    const r = reader();
    await r.start();
    // Before anything this reader reads, so it's passed over quietly as
    // already acknowledged, not warned of.
    fake.injectMalformed("box", { seq: 0 });
    fake.injectMalformed("box", { sub: undefined, actor: undefined, repo: undefined, pr: undefined });
    await until(() => r.pending().length === 1);
    expect(r.pending()[0]).toMatchObject({ seq: 2, sub: null, actor: null, repo: null, pr: null });
    expect(messages).toEqual([]);
  });
});

describe("a malformed message or page", () => {
  const warning = (what: string) => `${fake.url} sent a malformed ${what}: it isn't shaped as the protocol says; if this keeps happening, report it to the server's operator`;

  const wrappers: [label: string, what: string, wrap: (events: WatchEvent[]) => unknown][] = [
    ["null events", "events message", () => ({ type: "events", events: null })],
    ["events in an object", "events message", (events) => ({ type: "events", events: { 0: events[0] } })],
    ["a bare list", "message", (events) => events],
    ["null", "message", () => null],
    ["text that isn't JSON", "message", (events) => `{"type":"events","events":${JSON.stringify(events)}`],
    // Sound events as JSON, but in a binary frame, which isn't read.
    ["a binary frame", "binary message", (events) => Buffer.from(JSON.stringify({ type: "events", events }))],
    ["no type", "message", (events) => ({ events })],
    ["a type that isn't text", "message", (events) => ({ type: 1, events })],
  ];
  for (const [label, what, wrap] of wrappers) {
    it(`closes a WebSocket that sent a malformed ${what} (${label}), and reads its events again`, async () => {
      const r = reader();
      await r.start();
      const lost = fake.injectWrapped("box", wrap);
      await until(() => r.pending().length === 1);
      expect(r.pending()[0].id).toBe(lost.id);
      expect(messages).toEqual([warning(what), `reconnected to ${fake.url}`]);
      expect(fake.messages.filter((m) => m.includes("hello"))).toEqual([JSON.stringify({ type: "hello" }), JSON.stringify({ type: "hello", after: 0 })]);
    });
  }

  it("ignores a message of a type it doesn't know", async () => {
    const r = reader();
    await r.start();
    for (const s of fake.sockets) s.send(JSON.stringify({ type: "news", events: null }));
    const good = fake.inject("box", "comment.created");
    await until(() => r.pending().length === 1);
    expect(r.pending()[0].id).toBe(good.id);
    expect(messages).toEqual([]);
    expect(fake.helloTimes).toHaveLength(1);
  });

  it("starts the backoff again after a malformed message from a server that also sends events soundly", async () => {
    const r = new ServerReader(new ServerClient({ url: fake.url, apiKey: fake.token }), "box", { log: (m) => messages.push(m), takeBack: (e) => void takenBack.push(...e), backoff: [20, 2000] });
    readers.push(r);
    await r.start();
    for (let i = 1; i <= 4; i++) {
      const sent = Date.now();
      fake.injectWrapped("box", (events) => `{${JSON.stringify(events)}`);
      await until(() => fake.helloTimes.length === i + 1 && r.pending().length === 2 * i - 1);
      // 10-20 ms each time; doubling, the fourth would be 80-160 ms.
      expect(fake.helloTimes[i] - sent).toBeLessThan(60);
      fake.inject("box", "comment.created");
      await until(() => r.pending().length === 2 * i);
    }
  });

  it("backs off further each time a server keeps sending malformed messages", async () => {
    fake.garbageAfterReady = true;
    const r = new ServerReader(new ServerClient({ url: fake.url, apiKey: fake.token }), "box", { log: (m) => messages.push(m), takeBack: (e) => void takenBack.push(...e), backoff: [20, 400] });
    readers.push(r);
    await r.start();
    await until(() => fake.helloTimes.length >= 5);
    const gaps = fake.helloTimes.slice(1).map((t, i) => t - fake.helloTimes[i]);
    // 10-20 ms at first, then doubling: the fourth wait is 80-160 ms.
    expect(gaps[0]).toBeLessThan(60);
    expect(gaps[3]).toBeGreaterThanOrEqual(80);
    expect(messages[0]).toBe(warning("message"));
    for (const m of messages.slice(1)) expect([`reconnected to ${fake.url}`, `${fake.url} sent a malformed message; reconnecting`]).toContain(m);
    expect(messages).toContain(`${fake.url} sent a malformed message; reconnecting`);
  });

  it("backs off further when a server sends only empty events messages between malformed ones", async () => {
    fake.emptyBeforeGarbage = true;
    fake.garbageAfterReady = true;
    const r = new ServerReader(new ServerClient({ url: fake.url, apiKey: fake.token }), "box", { log: (m) => messages.push(m), takeBack: (e) => void takenBack.push(...e), backoff: [20, 400] });
    readers.push(r);
    await r.start();
    await until(() => fake.helloTimes.length >= 5);
    const gaps = fake.helloTimes.slice(1).map((t, i) => t - fake.helloTimes[i]);
    expect(gaps[3]).toBeGreaterThanOrEqual(80);
  });

  it("backs off further when a server sends only gaps that move the position back between malformed messages", async () => {
    fake.inbox("box").head = fake.inbox("box").acked = 10;
    fake.backGaps = true;
    fake.garbageAfterReady = true;
    const r = new ServerReader(new ServerClient({ url: fake.url, apiKey: fake.token }), "box", { log: (m) => messages.push(m), takeBack: (e) => void takenBack.push(...e), backoff: [20, 400] });
    readers.push(r);
    await r.start();
    await until(() => fake.helloTimes.length >= 5);
    // Each one was read, moving the position back one at a time.
    expect(fake.messages.filter((m) => m.includes("hello")).slice(1, 4)).toEqual([10, 9, 8].map((after) => JSON.stringify({ type: "hello", after })));
    const gaps = fake.helloTimes.slice(1).map((t, i) => t - fake.helloTimes[i]);
    expect(gaps[3]).toBeGreaterThanOrEqual(80);
  });

  it("doesn't count what an earlier connection read when a later one breaks before its ready", async () => {
    const r = new ServerReader(new ServerClient({ url: fake.url, apiKey: fake.token }), "box", { log: (m) => messages.push(m), takeBack: (e) => void takenBack.push(...e), backoff: [100, 2000] });
    readers.push(r);
    await r.start();
    fake.inject("box", "comment.created");
    await until(() => r.pending().length === 1);
    // No jitter: each wait is the whole delay.
    const random = vi.spyOn(Math, "random").mockReturnValue(1);
    try {
      fake.malformedReady = true;
      fake.closeSockets(1012, "restarting");
      await until(() => fake.helloTimes.length >= 3);
    } finally {
      random.mockRestore();
    }
    // Lost once (100 ms), then broken: the wait doubles (200 ms) rather
    // than starting again.
    expect(fake.helloTimes[2] - fake.helloTimes[1]).toBeGreaterThanOrEqual(150);
  });

  it("says so each time a page goes bad mid-run, warning in full only once", async () => {
    fake.refuseSockets = true;
    const r = reader();
    expect(await r.start()).toBe(true);
    for (let round = 0; round < 2; round++) {
      // The waiting poll answers soundly; the next one doesn't.
      fake.malformedPage = { events: null, next: 0, acked: 0 };
      fake.inject("box", "comment.created");
      await until(() => messages.length === 2 + 2 * round);
      fake.malformedPage = undefined;
      await until(() => messages.length === 3 + 2 * round);
    }
    expect(messages).toEqual([
      `couldn't open a WebSocket to ${fake.url}; long-polling instead`,
      warning("page of events"),
      `reconnected to ${fake.url}`,
      `${fake.url} sent a malformed page of events; reconnecting`,
      `reconnected to ${fake.url}`,
    ]);
    expect(r.pending()).toHaveLength(2);
  });

  it("closes a connection whose ready can't be read, and connects again", async () => {
    fake.malformedReady = true;
    const r = reader();
    expect(await r.start()).toBe(false);
    expect(messages).toEqual([warning("ready message")]);
    fake.malformedReady = false;
    await until(() => r.connected);
    const good = fake.inject("box", "comment.created");
    await until(() => r.pending().length === 1);
    expect(r.pending()[0].id).toBe(good.id);
  });

  for (const page of ["<html>Sign in to the Wi-Fi</html>", null, [], { events: null, next: 0, acked: 0 }, { events: [], next: "x", acked: 0 }, { events: [], next: 1.5, acked: 0 }, { events: [], next: 0, acked: null }]) {
    it(`is tried again long-polling, as after a 5xx: ${JSON.stringify(page)}`, async () => {
      fake.refuseSockets = true;
      fake.malformedPage = page;
      const r = reader();
      expect(await r.start()).toBe(false);
      await until(() => fake.requests.filter((q) => q.startsWith("GET /v1/inboxes/box/events")).length >= 2);
      expect(messages).toEqual([`couldn't open a WebSocket to ${fake.url}; long-polling instead`, warning("page of events")]);
      fake.malformedPage = undefined;
      await until(() => r.connected);
      const good = fake.inject("box", "comment.created");
      await until(() => r.pending().length === 1);
      expect(r.pending()[0].id).toBe(good.id);
      expect(fake.requests.filter((q) => q.includes("NaN") || q.includes("after=x"))).toEqual([]);
    });
  }
});

describe("an answer whose body can't be read", () => {
  const client = () => new ServerClient({ url: fake.url, apiKey: fake.token });

  it("is taken as no answer, to be tried again: cut off, timed out, or not JSON", async () => {
    fake.cutBodies = 1;
    const cut = (await client().ensureInbox("box").catch((e: Error) => e)) as Error;
    expect(cut).toBeInstanceOf(Unreachable);
    expect(cut).not.toBeInstanceOf(MalformedAnswer);
    expect(cut.message).toMatch(new RegExp(`^lost the answer from ${fake.url}: `));

    fake.cutBodies = 1;
    fake.stallCutBodies = true;
    const slow = (await client().request("PUT", "/v1/inboxes/box", { timeoutMs: 100 }).catch((e: Error) => e)) as Error;
    expect(slow).toBeInstanceOf(Unreachable);
    expect(slow.message).toMatch(new RegExp(`^lost the answer from ${fake.url}: `));

    fake.problem = { status: 200, body: "<html>Sign in to the Wi-Fi</html>" };
    const html = (await client().ensureInbox("box").catch((e: Error) => e)) as Error;
    expect(html).toBeInstanceOf(MalformedAnswer);
    expect(html.message).toBe(`${fake.url} sent an answer to PUT /v1/inboxes/box that isn't JSON`);
  });

  it("is passed on as it is when the caller gave up", async () => {
    fake.cutBodies = 1;
    fake.stallCutBodies = true;
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 50);
    const err = (await client().request("PUT", "/v1/inboxes/box", { signal: abort.signal }).catch((e: Error) => e)) as Error;
    expect(err).not.toBeInstanceOf(Unreachable);
    expect(err.name).toBe("AbortError");
  });

  it("is read again long-polling, with nothing lost", async () => {
    fake.refuseSockets = true;
    const r = reader();
    expect(await r.start()).toBe(true);
    messages.length = 0;
    fake.cutBodies = 1;
    const e = fake.inject("box", "comment.created");
    await until(() => r.pending().length === 1);
    expect(r.pending()[0].id).toBe(e.id);
    expect(r.failure).toBeNull();
    expect(messages[0]).toMatch(new RegExp(`^lost the answer from ${fake.url}: .*; reconnecting$`));
    expect(messages.at(-1)).toBe(`reconnected to ${fake.url}`);
  });
});

describe("what the server says", () => {
  // Colour, an OSC 8 link, a carriage return, a C1 CSI and a NUL.
  const NASTY = "\x1b[31mred\x1b]8;;https://evil.test\x07link\x1b]8;;\x07\rover\u009b2J\x00end";
  const CONTROLS = /[\x00-\x1f\x7f-\x9f]/;
  const client = () => new ServerClient({ url: fake.url, apiKey: fake.token });
  const log = (m: string) => void messages.push(m);

  it("is cleaned in errors, without cutting a long explanation short", async () => {
    const detail = `${NASTY} ${"because ".repeat(40)}the end`;
    fake.problem = { status: 422, body: { status: 422, code: "nope", title: NASTY, detail } };
    const refused = (await client().ensureInbox("box").catch((e: Error) => e)) as Error;
    expect(refused).toBeInstanceOf(ServerError);
    expect(refused.message).not.toMatch(CONTROLS);
    expect(refused.message).toMatch(/: 422 \[31mred \]8;;https:\/\/evil\.test link \]8;; over 2J end because .* the end$/);

    fake.problem = { status: 503, body: { status: 503, code: NASTY, title: NASTY } };
    const down = (await client().ensureInbox("box").catch((e: Error) => e)) as Error;
    expect(down).toBeInstanceOf(Unreachable);
    expect(down.message).not.toMatch(CONTROLS);
    expect(down.message).toMatch(/end: \[31mred/);

    fake.problem = { status: 401, body: { status: 401, code: NASTY } };
    const key = (await client().ensureInbox("box").catch((e: Error) => e)) as Error;
    expect(key).toBeInstanceOf(LoginNeeded);
    expect(key.message).not.toMatch(CONTROLS);
  });

  it("is cleaned when it won't watch a PR, or renew a watch", async () => {
    fake.problem = { status: 422, body: { status: 422, code: "nope", detail: NASTY } };
    expect(await subscribe(client(), "box", { owner: "octo", name: "widgets", number: 7 }, { log })).toBeNull();
    fake.problem = null;
    fake.repos.set(NASTY, { private: true });
    fake.subscriptions.push({ id: "sub_1", inbox: "box", repo: NASTY, pr: 7, githubToken: null });
    fake.verifiedUntil.set("sub_1", new Date(Date.now() + 3600_000).toISOString());
    await renewSubscriptions(client(), "box", { log });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatch(/won't watch octo\/widgets#7: \[31mred/);
    expect(messages[1]).toMatch(/keep watching \[31mred .* end; run/);
    for (const m of messages) expect(m).not.toMatch(CONTROLS);
  });

  it("is cleaned when it comes over the WebSocket", async () => {
    const r = reader();
    await r.start();
    for (const s of fake.sockets) s.send({ type: "error", code: NASTY, detail: NASTY });
    await until(() => messages.length === 1);
    expect(messages[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+: \[31mred .* end: \[31mred .* end$/);
    fake.closeSockets(4001, NASTY);
    expect(await r.changed(1000)).toBe(true);
    expect(r.failure).toBeInstanceOf(LoginNeeded);
    expect(r.failure!.message).toMatch(/rejected the API key \(\[31mred/);
    for (const m of [...messages, r.failure!.message]) expect(m).not.toMatch(CONTROLS);
  });

  it("can't redirect a request, which fails saying why", async () => {
    const fetches = vi.spyOn(globalThis, "fetch");
    // The hint names the config file where it really is.
    vi.stubEnv("WATCHERONI_CONFIG_DIR", "/etc/watcheroni-test");
    try {
      fake.redirectTo = `http://127.0.0.1:${fake.port}/elsewhere`;
      const moved = `answered 307 redirecting to "http://127.0.0.1:${fake.port}/elsewhere", which watcheroni doesn't follow; check the server URL in $WATCHERONI_SERVER or /etc/watcheroni-test/config.json`;
      const err = (await client().ack("box", 1).catch((e: Error) => e)) as Error;
      expect(fetches.mock.calls[0][1]).toMatchObject({ method: "POST", redirect: "manual" });
      expect(err).toBeInstanceOf(ServerError);
      expect(err.message).toBe(`${fake.url}: POST /v1/inboxes/box/ack: ${moved}`);
      expect(fake.requests).toEqual(["POST /v1/inboxes/box/ack"]);
      expect(await subscribe(client(), "box", { owner: "octo", name: "widgets", number: 7 }, { log })).toBeNull();
      expect(messages).toEqual([`${fake.url} won't watch octo/widgets#7: ${moved}`]);

      // Nor a refresh, whose body is the refresh token. Where it points
      // is cleaned too.
      const path = join(mkdtempSync(join(tmpdir(), "watcheroni-cred-")), "credentials.json");
      process.env.WATCHERONI_CREDENTIALS = path;
      const github = { access_token: "ghu_old", refresh_token: "ghr_old", expires_at: new Date(Date.now() - 1000).toISOString(), refresh_token_expires_at: null };
      writeFileSync(path, JSON.stringify({ servers: { [fake.url]: { api_key: fake.token, key_id: "key_1", account: { id: 7, login: "octocat" }, github } } }));
      fake.redirectTo = "http://evil.test/\u009b2J";
      const refresh = (await githubTokenFor(fake.url).catch((e: Error) => e)) as Error;
      expect(fetches.mock.calls.at(-1)![1]).toMatchObject({ method: "POST", redirect: "manual" });
      expect(refresh).toBeInstanceOf(Unreachable);
      expect(refresh.message).toBe(`${fake.url}/v1/github/refresh answered 307 redirecting to "http://evil.test/ 2J", which watcheroni doesn't follow; check the server URL in $WATCHERONI_SERVER or /etc/watcheroni-test/config.json`);
      expect(fake.refreshed).toEqual([]);
    } finally {
      fetches.mockRestore();
      vi.unstubAllEnvs();
      delete process.env.WATCHERONI_CREDENTIALS;
    }
  });
});
