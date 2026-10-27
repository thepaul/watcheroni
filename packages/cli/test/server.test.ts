import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Feed } from "../src/feed.ts";
import { LoginNeeded } from "../src/github.ts";
import { Inbox } from "../src/inbox.ts";
import { ServerClient, ServerReader } from "../src/server.ts";
import type { Snapshot } from "../src/snapshot.ts";
import { targetKey } from "../src/targets.ts";
import { FakeServer } from "./fake-server.ts";
import { alice, snap } from "./fixtures.ts";

let fake: FakeServer;
let readers: ServerReader[] = [];
const messages: string[] = [];

beforeEach(async () => {
  process.env.WATCHERONI_STATE_DIR = mkdtempSync(join(tmpdir(), "watcheroni-test-"));
  fake = await new FakeServer().start();
  messages.length = 0;
});
afterEach(async () => {
  await Promise.all(readers.map((r) => r.close()));
  readers = [];
  await fake.stop();
});

function reader(name = "box", token = fake.token): ServerReader {
  const r = new ServerReader(new ServerClient({ url: fake.url, apiKey: token }), name, {
    log: (m) => messages.push(m),
    backoff: [20, 100],
  });
  readers.push(r);
  return r;
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
    r.ack(3);
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
    r.ack(1);
    await until(() => fake.inbox("box").acked === 1);
    // The next poll starts after what it has.
    await until(() => fake.requests.includes("GET /v1/inboxes/box/events?wait=300&after=1"));
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
});
