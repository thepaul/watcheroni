import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Feed } from "../src/feed.ts";
import { LoginNeeded } from "../src/github.ts";
import { Inbox } from "../src/inbox.ts";
import { type Credentials, type ServerCredentials, githubTokenFor } from "../src/login.ts";
import { ServerClient, ServerReader, Unreachable, renewSubscriptions, subscribe } from "../src/server.ts";
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
