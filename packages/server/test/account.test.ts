import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AccountStats } from "../src/account";
import {
  ACCOUNT_MAX_INBOXES,
  ACCOUNT_MAX_LONG_POLLS,
  ACCOUNT_MAX_SOCKETS,
  INBOX_IDLE_DAYS,
  INBOX_MAX_AGE_DAYS,
  INBOX_MAX_EVENTS,
  type EventsPage,
  type InboxInfo,
  type InboxesResponse,
  type LoginResponse,
  type ServerMessage,
  type SubscriptionInfo,
} from "../src/protocol";

const BASE = "https://watcheroni.test";
// Every test here works in one account, with a key minted through /debug.
const ACCOUNT_ID = 1001;
const DEBUG = { Authorization: "Bearer test-debug-token" };
const minted = await exports.default.fetch(`${BASE}/debug/accounts/${ACCOUNT_ID}/keys`, { method: "POST", headers: DEBUG });
const { api_key } = await minted.json<LoginResponse>();
const AUTH = { Authorization: `Bearer ${api_key}` };

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(`${BASE}${path}`, { ...init, headers: { ...AUTH, ...init.headers } });
}

let inboxCounter = 0;
async function newInbox(): Promise<string> {
  const name = `t${Date.now()}-${inboxCounter++}`;
  expect((await call(`/v1/inboxes/${name}`, { method: "PUT" })).status).toBe(200);
  return name;
}

function inject(inbox: string, body: Record<string, unknown> = {}): Promise<Response> {
  return exports.default.fetch(`${BASE}/debug/accounts/${ACCOUNT_ID}/inboxes/${inbox}/events`, {
    method: "POST",
    headers: DEBUG,
    body: JSON.stringify(body),
  });
}

async function stats(): Promise<AccountStats> {
  return (await exports.default.fetch(`${BASE}/debug/accounts/${ACCOUNT_ID}/stats`, { headers: DEBUG })).json();
}

// A WebSocket client that records every message.
async function connect(inbox: string) {
  const res = await call(`/v1/inboxes/${inbox}/ws`, { headers: { Upgrade: "websocket" } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const messages: ServerMessage[] = [];
  ws.addEventListener("message", (ev) => {
    messages.push(JSON.parse(String(ev.data)));
  });
  ws.accept();
  const waitFor = async (pred: (m: ServerMessage[]) => boolean, ms = 2000) => {
    const end = Date.now() + ms;
    while (!pred(messages)) {
      if (Date.now() > end) throw new Error(`timed out; got ${JSON.stringify(messages)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { ws, messages, waitFor };
}

const eventsOf = (msgs: ServerMessage[]) => msgs.flatMap((m) => (m.type === "events" ? m.events : []));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("long-polling", () => {
  it("returns waiting events at once and numbers them", async () => {
    const inbox = await newInbox();
    await inject(inbox, { count: 3 });
    const page = await (await call(`/v1/inboxes/${inbox}/events?wait=30`)).json<EventsPage>();
    expect(page.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(page).toMatchObject({ next: 3, head: 3, acked: 0 });
  });

  it("starts from the acknowledged position", async () => {
    const inbox = await newInbox();
    await inject(inbox, { count: 3 });
    await call(`/v1/inboxes/${inbox}/ack`, { method: "POST", body: JSON.stringify({ seq: 2 }) });
    const page = await (await call(`/v1/inboxes/${inbox}/events`)).json<EventsPage>();
    expect(page.events.map((e) => e.seq)).toEqual([3]);
    expect(page.acked).toBe(2);
  });

  it("ignores an ack past head, over HTTP or the WebSocket, rather than taking it as head", async () => {
    const inbox = await newInbox();
    await inject(inbox, { count: 3 });
    const ack = async (seq: number) =>
      (await call(`/v1/inboxes/${inbox}/ack`, { method: "POST", body: JSON.stringify({ seq }) })).json<{ head: number; acked: number }>();
    expect(await ack(4)).toMatchObject({ head: 3, acked: 0 });
    expect(await ack(2)).toMatchObject({ head: 3, acked: 2 });
    expect(await ack(3)).toMatchObject({ head: 3, acked: 3 });
    expect(await ack(1)).toMatchObject({ acked: 3 });
    await inject(inbox, { count: 1 });
    const c = await connect(inbox);
    c.ws.send(JSON.stringify({ type: "hello" }));
    await c.waitFor((m) => eventsOf(m).length === 1);
    c.ws.send(JSON.stringify({ type: "ack", seq: 9 }));
    await sleep(50);
    expect((await stats()).inboxes.find((i) => i.name === inbox)?.acked).toBe(3);
    c.ws.send(JSON.stringify({ type: "ack", seq: 4 }));
    await sleep(50);
    expect((await stats()).inboxes.find((i) => i.name === inbox)?.acked).toBe(4);
    c.ws.close();
  });

  it("waits through the bridge and wakes when an event arrives", async () => {
    const inbox = await newInbox();
    const started = Date.now();
    const poll = call(`/v1/inboxes/${inbox}/events?wait=30`);
    await sleep(200);
    // The Worker is now holding the request, with a bridge socket open.
    const during = await stats();
    expect(during.sockets.filter((s) => s.inbox === inbox && s.mode === "bridge")).toHaveLength(1);

    await inject(inbox, { kind: "review.submitted" });
    const page = await (await poll).json<EventsPage>();
    expect(page.events.map((e) => e.kind)).toEqual(["review.submitted"]);
    expect(page.next).toBe(1);
    expect(Date.now() - started).toBeLessThan(5000);

    await sleep(50);
    const after = await stats();
    expect(after.sockets.filter((s) => s.inbox === inbox)).toHaveLength(0);
  });

  it("returns an empty page when the wait runs out", async () => {
    const inbox = await newInbox();
    const page = await (await call(`/v1/inboxes/${inbox}/events?wait=1`)).json<EventsPage>();
    expect(page).toMatchObject({ events: [], next: 0, head: 0 });
  });

  it("404s for an unknown inbox", async () => {
    expect((await call("/v1/inboxes/nope-never-made/events")).status).toBe(404);
  });

  it("refuses an after that isn't a non-negative integer, as hello does", async () => {
    const inbox = await newInbox();
    for (const after of ["-1", "1.5", "x", "", "99999999999999999999"]) {
      const res = await call(`/v1/inboxes/${inbox}/events?after=${after}`);
      expect(res.status, after).toBe(400);
      expect(await res.json()).toMatchObject({ code: "invalid_request" });
    }
  });
});

describe("WebSocket", () => {
  it("sends ready, then backlog, then live events, and takes acks", async () => {
    const inbox = await newInbox();
    await inject(inbox, { count: 2 });
    const c = await connect(inbox);
    c.ws.send(JSON.stringify({ type: "hello" }));
    await c.waitFor((m) => eventsOf(m).length === 2);
    expect(c.messages[0]).toEqual({ type: "ready", inbox, head: 2, acked: 0 });

    await inject(inbox, { kind: "check.failed" });
    await c.waitFor((m) => eventsOf(m).length === 3);
    expect(eventsOf(c.messages)[2]).toMatchObject({ seq: 3, kind: "check.failed" });

    c.ws.send(JSON.stringify({ type: "ack", seq: 3 }));
    await sleep(50);
    const s = await stats();
    expect(s.inboxes.find((i) => i.name === inbox)?.acked).toBe(3);
    c.ws.close();
  });

  it("answers ping with pong", async () => {
    const inbox = await newInbox();
    const res = await call(`/v1/inboxes/${inbox}/ws`, { headers: { Upgrade: "websocket" } });
    const ws = res.webSocket!;
    const got: string[] = [];
    ws.addEventListener("message", (ev) => {
      got.push(String(ev.data));
    });
    ws.accept();
    ws.send("ping");
    for (let i = 0; i < 100 && !got.length; i++) await sleep(10);
    expect(got).toEqual(["pong"]);
    ws.close();
  });

  it("refuses a hello whose after isn't a non-negative integer", async () => {
    const inbox = await newInbox();
    await inject(inbox, { count: 2 });
    const c = await connect(inbox);
    for (const after of [-1, 1.5, "1"]) c.ws.send(JSON.stringify({ type: "hello", after }));
    await c.waitFor((m) => m.length === 3);
    expect(c.messages.map((m) => m.type === "error" && m.code)).toEqual(["invalid_request", "invalid_request", "invalid_request"]);
    // Nothing was sent from those, and a good hello still works: a null
    // after, like none, starts from what's acked.
    c.ws.send(JSON.stringify({ type: "hello", after: null }));
    await c.waitFor((m) => eventsOf(m).length === 2);
    expect(eventsOf(c.messages).map((e) => e.seq)).toEqual([1, 2]);
    c.ws.close();
  });

  it("pushes nothing before hello", async () => {
    const inbox = await newInbox();
    const c = await connect(inbox);
    await inject(inbox);
    await sleep(100);
    expect(c.messages).toEqual([]);
    c.ws.close();
  });
});

describe("gaps", () => {
  const stub = (account = ACCOUNT_ID) => env.ACCOUNT.get(env.ACCOUNT.idFromName(`acct:${account}`));
  const read = async (inbox: string, query = "") => (await call(`/v1/inboxes/${inbox}/events${query}`)).json<EventsPage>();
  const DAY = 24 * 3600 * 1000;
  // Makes an inbox's events up to `seq` older than an inbox keeps.
  const age = (inbox: string, seq: number, account = ACCOUNT_ID) =>
    runInDurableObject(stub(account), (_, state) => {
      state.storage.sql.exec("UPDATE events SET at = ? WHERE inbox = ? AND seq <= ?", Date.now() - (INBOX_MAX_AGE_DAYS + 1) * DAY, inbox, seq);
    });
  const kept = (inbox: string, account = ACCOUNT_ID) =>
    runInDurableObject(stub(account), (_, state) =>
      state.storage.sql.exec<{ seq: number }>("SELECT seq FROM events WHERE inbox = ? ORDER BY seq", inbox).toArray().map((r) => r.seq),
    );
  const alarmAt = (account = ACCOUNT_ID) => runInDurableObject(stub(account), (_, state) => state.storage.getAlarm());
  // An account of its own, for tests that look at its one alarm.
  let accountCounter = 2000;
  async function ownAccount() {
    const account = accountCounter++;
    const res = await exports.default.fetch(`${BASE}/debug/accounts/${account}/keys`, { method: "POST", headers: DEBUG });
    const auth = { Authorization: `Bearer ${(await res.json<LoginResponse>()).api_key}` };
    const newBox = async (name: string) => {
      expect((await exports.default.fetch(`${BASE}/v1/inboxes/${name}`, { method: "PUT", headers: auth })).status).toBe(200);
    };
    const add = (inbox: string, count = 1) =>
      exports.default.fetch(`${BASE}/debug/accounts/${account}/inboxes/${inbox}/events`, { method: "POST", headers: DEBUG, body: JSON.stringify({ count }) });
    return { account, newBox, add };
  }

  it(`starts a read from before the last ${INBOX_MAX_EVENTS} events with inbox.gap`, async () => {
    const inbox = await newInbox();
    for (let i = 0; i < 10; i++) await inject(inbox, { count: 100 });
    await inject(inbox, { count: 5 });
    // The first event kept, of 1,005.
    const first = 1005 - INBOX_MAX_EVENTS + 1;

    const page = await read(inbox, "?after=0&limit=3&wait=30");
    expect(page.events.map((e) => [e.seq, e.kind])).toEqual([[first - 1, "inbox.gap"], [first, "debug.ping"], [first + 1, "debug.ping"]]);
    expect(page.events[0]).toMatchObject({ v: 1, sub: null, repo: null, pr: null, actor: null, data: { missed_after: 0, resumed_at: first } });
    expect(page.next).toBe(first + 1);
    // From acked (0), the same gap, under the same ID.
    const again = await read(inbox, "?limit=1");
    expect(again.events).toEqual([{ ...page.events[0], at: again.events[0].at, received_at: again.events[0].received_at }]);
    expect(again.next).toBe(first - 1);
    // Past it, or right at the boundary, there's none.
    expect((await read(inbox, `?after=${first - 1}&limit=1`)).events.map((e) => e.seq)).toEqual([first]);
    // A position inside what was dropped gets its own.
    expect((await read(inbox, "?after=3&limit=1")).events[0]).toMatchObject({ seq: first - 1, data: { missed_after: 3, resumed_at: first } });
  });

  it("sends inbox.gap over the WebSocket too", async () => {
    const inbox = await newInbox();
    await inject(inbox, { count: 4 });
    await age(inbox, 2);
    const c = await connect(inbox);
    c.ws.send(JSON.stringify({ type: "hello", after: 1 }));
    await c.waitFor((m) => eventsOf(m).length === 3);
    expect(eventsOf(c.messages).map((e) => [e.seq, e.kind])).toEqual([[2, "inbox.gap"], [3, "debug.ping"], [4, "debug.ping"]]);
    expect(eventsOf(c.messages)[0].data).toEqual({ missed_after: 1, resumed_at: 3 });
    // New events follow without another.
    await inject(inbox);
    await c.waitFor((m) => eventsOf(m).length === 4);
    expect(eventsOf(c.messages)[3]).toMatchObject({ seq: 5, kind: "debug.ping" });
    c.ws.close();
  });

  it("drops events older than the inbox keeps, from reads at once and from storage at the alarm", async () => {
    const inbox = await newInbox();
    await inject(inbox, { count: 3 });
    expect(await runInDurableObject(stub(), (_, state) => state.storage.getAlarm())).not.toBeNull();
    await age(inbox, 2);
    expect((await read(inbox, "?after=0")).events.map((e) => [e.seq, e.kind])).toEqual([[2, "inbox.gap"], [3, "debug.ping"]]);

    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await kept(inbox)).toEqual([3]);
    // Events remain, so the alarm set itself again.
    const next = await runInDurableObject(stub(), (_, state) => state.storage.getAlarm());
    expect(next).toBeGreaterThan(Date.now());

    // With nothing left, a reader behind `head` still hears of it; the gap
    // takes `head`, and resumes at the next event to come.
    await age(inbox, 3);
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await kept(inbox)).toEqual([]);
    const page = await read(inbox, "?after=1");
    expect(page.events.map((e) => [e.seq, e.kind])).toEqual([[3, "inbox.gap"]]);
    expect(page.events[0].data).toEqual({ missed_after: 1, resumed_at: 4 });
    expect(page).toMatchObject({ next: 3, head: 3 });
    expect((await read(inbox, "?after=3")).events).toEqual([]);
    await inject(inbox);
    expect((await read(inbox, "?after=3")).events.map((e) => e.seq)).toEqual([4]);
  });

  it(`sends inbox.gap through the bridge to a long poll that more than ${INBOX_MAX_EVENTS} events overtake`, async () => {
    const inbox = await newInbox();
    const poll = call(`/v1/inboxes/${inbox}/events?after=0&wait=30`);
    await sleep(200);
    expect((await stats()).sockets.filter((s) => s.inbox === inbox && s.mode === "bridge")).toHaveLength(1);
    // More than the debug endpoint takes at once, straight to the account.
    const now = new Date().toISOString();
    await stub().deliver(
      Array.from({ length: INBOX_MAX_EVENTS + 5 }, (_, i) => ({
        inbox,
        event: { v: 1, id: `bulk:${inbox}:${i}`, sub: null, kind: "debug.ping", at: now, received_at: now, repo: null, pr: null, actor: null, data: {}, links: {} },
      })),
    );
    const page = await (await poll).json<EventsPage>();
    expect(page.events.slice(0, 2).map((e) => [e.seq, e.kind])).toEqual([[5, "inbox.gap"], [6, "debug.ping"]]);
    expect(page.events[0].data).toEqual({ missed_after: 0, resumed_at: 6 });
  });

  it("sets the alarm for when the oldest event kept gets too old, even if that's now", async () => {
    const { account, newBox, add } = await ownAccount();
    await newBox("box");
    await add("box", 2);
    // As for an account whose events predate the alarm.
    await age("box", 1, account);
    await runInDurableObject(stub(account), (_, state) => state.storage.deleteAlarm());
    await add("box");
    // It's due at once, so it runs and prunes by itself.
    for (let i = 0; i < 200 && (await kept("box", account))[0] === 1; i++) await sleep(10);
    expect(await kept("box", account)).toEqual([2, 3]);
  });

  it("prunes every inbox at the alarm, and leaves none set once nothing's kept", async () => {
    const { account, newBox, add } = await ownAccount();
    await newBox("a");
    await newBox("b");
    await add("a", 3);
    await add("b", 3);
    await age("a", 2, account);
    await age("b", 1, account);
    expect(await runDurableObjectAlarm(stub(account))).toBe(true);
    expect(await kept("a", account)).toEqual([3]);
    expect(await kept("b", account)).toEqual([2, 3]);
    expect(await alarmAt(account)).not.toBeNull();

    await age("a", 3, account);
    await age("b", 3, account);
    expect(await runDurableObjectAlarm(stub(account))).toBe(true);
    expect(await kept("a", account)).toEqual([]);
    expect(await kept("b", account)).toEqual([]);
    expect(await alarmAt(account)).toBeNull();
  });

  it("brings a position ahead of head back with inbox.gap, then everything kept", async () => {
    const inbox = await newInbox();
    await inject(inbox, { count: 3 });
    await age(inbox, 1);
    const page = await read(inbox, "?after=9&wait=30");
    expect(page.events.map((e) => [e.seq, e.kind])).toEqual([[1, "inbox.gap"], [2, "debug.ping"], [3, "debug.ping"]]);
    expect(page.events[0].data).toEqual({ missed_after: 9, resumed_at: 2 });
    expect(page).toMatchObject({ next: 3, head: 3 });
    // From where that leaves it, it's an ordinary reader.
    expect((await read(inbox, "?after=3")).events).toEqual([]);

    // Over the WebSocket too; new events follow without another gap.
    const c = await connect(inbox);
    c.ws.send(JSON.stringify({ type: "hello", after: Number.MAX_SAFE_INTEGER }));
    await c.waitFor((m) => eventsOf(m).length === 3);
    expect(eventsOf(c.messages).map((e) => [e.seq, e.kind])).toEqual([[1, "inbox.gap"], [2, "debug.ping"], [3, "debug.ping"]]);
    expect(eventsOf(c.messages)[0].data).toEqual({ missed_after: Number.MAX_SAFE_INTEGER, resumed_at: 2 });
    await inject(inbox);
    await c.waitFor((m) => eventsOf(m).length === 4);
    expect(eventsOf(c.messages)[3]).toMatchObject({ seq: 4, kind: "debug.ping" });
    c.ws.close();

    // With nothing kept, the gap takes `head`.
    await age(inbox, 4);
    const empty = await read(inbox, "?after=9");
    expect(empty.events.map((e) => [e.seq, e.kind])).toEqual([[4, "inbox.gap"]]);
    expect(empty.events[0].data).toEqual({ missed_after: 9, resumed_at: 5 });
    expect(empty.next).toBe(4);
  });

  it("sends none to a reader that missed nothing", async () => {
    const inbox = await newInbox();
    expect((await read(inbox)).events).toEqual([]);
    expect((await read(inbox, "?after=0")).events).toEqual([]);
    await inject(inbox, { count: 2 });
    expect((await read(inbox, "?after=0")).events.map((e) => e.kind)).toEqual(["debug.ping", "debug.ping"]);
    expect((await read(inbox, "?after=2")).events).toEqual([]);
    const c = await connect(inbox);
    c.ws.send(JSON.stringify({ type: "hello" }));
    await c.waitFor((m) => eventsOf(m).length === 2);
    await sleep(50);
    expect(eventsOf(c.messages).map((e) => e.kind)).toEqual(["debug.ping", "debug.ping"]);
    c.ws.close();
  });
});

describe("hibernation", () => {
  it("keeps client and bridge sockets, and their positions, across eviction", async () => {
    const inbox = await newInbox();
    const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName(`acct:${ACCOUNT_ID}`));

    const c = await connect(inbox);
    c.ws.send(JSON.stringify({ type: "hello" }));
    await c.waitFor((m) => m.some((x) => x.type === "ready"));
    const poll = call(`/v1/inboxes/${inbox}/events?wait=30`);
    await sleep(200);
    const before = await stats();

    // Fails if anything (an open request, a timer) pins the object in memory.
    await evictDurableObject(stub);

    await inject(inbox, { kind: "pr.merged" });
    await c.waitFor((m) => eventsOf(m).length === 1);
    expect(eventsOf(c.messages)[0]).toMatchObject({ seq: 1, kind: "pr.merged" });
    const page = await (await poll).json<EventsPage>();
    expect(page.events.map((e) => e.seq)).toEqual([1]);

    const after = await stats();
    expect(after.instance).not.toBe(before.instance);
    expect(after.wakes.map((w) => w.instance)).toContain(before.instance);
    // The client socket outlived the instance that accepted it.
    expect(after.sockets.filter((s) => s.inbox === inbox && s.mode === "client")).toHaveLength(1);
    c.ws.close();
  });
});

describe("per-account caps", () => {
  // Each test has an account of its own, so its sockets and inboxes don't
  // count against the others'.
  let nextAccount = 5000;
  async function account() {
    const id = nextAccount++;
    const res = await exports.default.fetch(`${BASE}/debug/accounts/${id}/keys`, { method: "POST", headers: DEBUG });
    const auth = { Authorization: `Bearer ${(await res.json<LoginResponse>()).api_key}` };
    const call = (path: string, init: RequestInit = {}) =>
      exports.default.fetch(`${BASE}${path}`, { ...init, headers: { ...auth, ...init.headers } });
    const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName(`acct:${id}`));
    const stats = async () => (await exports.default.fetch(`${BASE}/debug/accounts/${id}/stats`, { headers: DEBUG })).json<AccountStats>();
    const inject = (inbox: string) =>
      exports.default.fetch(`${BASE}/debug/accounts/${id}/inboxes/${inbox}/events`, { method: "POST", headers: DEBUG, body: "{}" });
    return { call, stub, stats, inject };
  }

  // Opens a client socket. Resolves with the close code and reason if the
  // server closes it within `ms`, or with the socket if it's still open.
  async function open(call: (path: string, init?: RequestInit) => Promise<Response>, inbox: string, ms = 200) {
    const res = await call(`/v1/inboxes/${inbox}/ws`, { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.addEventListener("close", (ev) => resolve({ code: ev.code, reason: ev.reason })),
    );
    ws.accept();
    return Promise.race([closed, sleep(ms).then(() => ws)]);
  }

  it(`allows ${ACCOUNT_MAX_INBOXES} inboxes, then makes room by deleting idle ones`, async () => {
    const { call, stub } = await account();
    await runInDurableObject(stub, (_, state) => {
      for (let i = 1; i < ACCOUNT_MAX_INBOXES; i++) {
        state.storage.sql.exec("INSERT INTO inboxes (name, created_at) VALUES (?, ?)", `fake${i}`, Date.now());
      }
    });
    expect((await call("/v1/inboxes/last", { method: "PUT" })).status).toBe(200);

    const refused = await call("/v1/inboxes/one-too-many", { method: "PUT" });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ code: "quota_exceeded", title: `Too many inboxes on this account (at most ${ACCOUNT_MAX_INBOXES})` });
    // Nor by connecting to it; an inbox that exists is still fine.
    expect((await call("/v1/inboxes/one-too-many/ws", { headers: { Upgrade: "websocket" } })).status).toBe(422);
    expect((await call("/v1/inboxes/last", { method: "PUT" })).status).toBe(200);

    // Unread for too long but subscribed to: kept. Unread with nothing
    // subscribed: deleted, with its events.
    const old = Date.now() - (INBOX_IDLE_DAYS + 1) * 24 * 3600 * 1000;
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec("UPDATE inboxes SET created_at = ?, last_read_at = ? WHERE name IN ('fake1', 'fake2')", old, old);
      state.storage.sql.exec(
        "INSERT INTO subscriptions (id, inbox, repo_id, repo_name, private, pr, spec, created_at, expires_at) VALUES ('sub_x', 'fake1', 1, 'o/r', 0, 1, '{}', 0, 0)",
      );
      state.storage.sql.exec("INSERT INTO events (inbox, seq, id, body, at) VALUES ('fake2', 1, 'e1', '{}', 0)");
    });
    expect((await call("/v1/inboxes/one-too-many", { method: "PUT" })).status).toBe(200);
    const left = await runInDurableObject(stub, (_, state) => ({
      inboxes: state.storage.sql.exec<{ name: string }>("SELECT name FROM inboxes WHERE name IN ('fake1', 'fake2')").toArray().map((r) => r.name),
      events: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE inbox = 'fake2'").one().n,
    }));
    expect(left).toEqual({ inboxes: ["fake1"], events: 0 });
    expect((await call("/v1/inboxes/and-another", { method: "PUT" })).status).toBe(422);
  });

  it("makes a deleted inbox again where it left off, so old positions are behind, never ahead", async () => {
    const { call, stub, inject } = await account();
    const read = async (query: string) => (await call(`/v1/inboxes/gone/events${query}`)).json<EventsPage>();
    expect((await call("/v1/inboxes/gone", { method: "PUT" })).status).toBe(200);
    for (let i = 0; i < 5; i++) await inject("gone");
    await call("/v1/inboxes/gone/ack", { method: "POST", body: JSON.stringify({ seq: 3 }) });
    const old = Date.now() - (INBOX_IDLE_DAYS + 1) * 24 * 3600 * 1000;
    await runInDurableObject(stub, (_, state) => {
      for (let i = 1; i < ACCOUNT_MAX_INBOXES; i++) {
        state.storage.sql.exec("INSERT INTO inboxes (name, created_at) VALUES (?, ?)", `fake${i}`, Date.now());
      }
      state.storage.sql.exec("UPDATE inboxes SET created_at = ?, last_read_at = ? WHERE name = 'gone'", old, old);
    });
    expect((await call("/v1/inboxes/newcomer", { method: "PUT" })).status).toBe(200);
    expect((await call("/v1/inboxes/gone/events")).status).toBe(404);

    // Made again (with room for it), it carries on from head 5 and acked 3.
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec("DELETE FROM inboxes WHERE name = 'fake1'");
    });
    const made = await (await call("/v1/inboxes/gone", { method: "PUT" })).json<{ head: number; acked: number }>();
    expect(made).toMatchObject({ head: 5, acked: 3 });
    expect(await runInDurableObject(stub, (_, state) => state.storage.sql.exec("SELECT * FROM deleted_inboxes").toArray())).toEqual([]);

    // A reader caught up when it went gets the new events, from seq 6; one
    // behind, or one starting from acked, hears it missed some.
    const poll = call("/v1/inboxes/gone/events?after=5&wait=30");
    await sleep(200);
    await inject("gone");
    expect((await (await poll).json<EventsPage>()).events.map((e) => e.seq)).toEqual([6]);
    for (const page of [await read("?after=3"), await read("")]) {
      expect(page.events.map((e) => [e.seq, e.kind])).toEqual([[5, "inbox.gap"], [6, "debug.ping"]]);
      expect(page.events[0].data).toEqual({ missed_after: 3, resumed_at: 6 });
    }
    // Over the WebSocket too.
    const res = await call("/v1/inboxes/gone/ws", { headers: { Upgrade: "websocket" } });
    const ws = res.webSocket!;
    const got: ServerMessage[] = [];
    ws.addEventListener("message", (ev) => {
      got.push(JSON.parse(String(ev.data)));
    });
    ws.accept();
    ws.send(JSON.stringify({ type: "hello", after: 4 }));
    for (let i = 0; i < 200 && eventsOf(got).length < 2; i++) await sleep(10);
    expect(got[0]).toMatchObject({ type: "ready", head: 6, acked: 3 });
    expect(eventsOf(got).map((e) => [e.seq, e.kind])).toEqual([[5, "inbox.gap"], [6, "debug.ping"]]);
    ws.close();
  });

  it("keeps an inbox a subscription is being made for, even at the cap", async () => {
    const { call, stub } = await account();
    expect((await call("/v1/inboxes/target", { method: "PUT" })).status).toBe(200);
    const old = Date.now() - (INBOX_IDLE_DAYS + 1) * 24 * 3600 * 1000;
    await runInDurableObject(stub, (_, state) => {
      for (let i = 1; i < ACCOUNT_MAX_INBOXES; i++) {
        state.storage.sql.exec("INSERT INTO inboxes (name, created_at) VALUES (?, ?)", `fake${i}`, Date.now());
      }
      state.storage.sql.exec("UPDATE inboxes SET created_at = ?, last_read_at = ? WHERE name = 'target'", old, old);
    });
    const now = new Date().toISOString();
    const sub: SubscriptionInfo = {
      id: "sub_race", inbox: "target", repo: { id: 1, full_name: "o/r", private: false }, pr: 1, kinds: [],
      ignore: { self: false, bots: false, actors: [] }, created_at: now, expires_at: now, verified_until: null, state: "active",
    };
    // The Worker checks, then calls RepoHub, then saves. A PUT in between
    // finds a subscription being made to the inbox, so not idle: no room.
    expect(await stub.checkSubscription("target")).toEqual({ ok: true });
    expect((await call("/v1/inboxes/newcomer", { method: "PUT" })).status).toBe(422);
    expect(await stub.saveSubscription(sub)).toEqual({ ok: true });
    expect((await stub.listSubscriptions("target"))?.map((s) => s.id)).toEqual(["sub_race"]);

    // Had it gone anyway, the save is refused rather than kept for no inbox.
    expect(await stub.checkSubscription("fake1")).toEqual({ ok: true });
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec("DELETE FROM inboxes WHERE name = 'fake1'");
    });
    expect(await stub.saveSubscription({ ...sub, id: "sub_lost", inbox: "fake1" })).toMatchObject({ ok: false, status: 404, code: "not_found" });
    expect(await stub.getSubscription("fake1", "sub_lost")).toBeNull();
  });

  it(`allows ${ACCOUNT_MAX_SOCKETS} WebSockets, closes more with 4029, and counts across hibernation`, async () => {
    const { call, stub, stats } = await account();
    expect((await call("/v1/inboxes/socks", { method: "PUT" })).status).toBe(200);
    const sockets: WebSocket[] = [];
    for (let i = 0; i < ACCOUNT_MAX_SOCKETS; i++) {
      const ws = await open(call, "socks", 0);
      expect(ws).toBeInstanceOf(WebSocket);
      sockets.push(ws as WebSocket);
    }
    await sleep(100);
    for (const ws of sockets) expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(await open(call, "socks")).toEqual({ code: 4029, reason: "too many connections" });

    // The count is the runtime's, not the instance's.
    await evictDurableObject(stub);
    expect(await open(call, "socks")).toEqual({ code: 4029, reason: "too many connections" });
    expect((await stats()).sockets.filter((s) => s.mode === "client")).toHaveLength(ACCOUNT_MAX_SOCKETS);

    // Hanging one up makes room for another.
    sockets.pop()!.close(1000);
    for (let i = 0; i < 100 && (await stats()).sockets.length >= ACCOUNT_MAX_SOCKETS; i++) await sleep(10);
    const again = await open(call, "socks");
    expect(again).toBeInstanceOf(WebSocket);
    for (const ws of [...sockets, again as WebSocket]) ws.close(1000);
  });

  it(`allows ${ACCOUNT_MAX_LONG_POLLS} long polls waiting at once, then 429`, async () => {
    const { call, stats, inject } = await account();
    for (const name of ["many", "one"]) expect((await call(`/v1/inboxes/${name}`, { method: "PUT" })).status).toBe(200);
    const bridges = async () => (await stats()).sockets.filter((s) => s.mode === "bridge").length;
    const polls = [call("/v1/inboxes/one/events?wait=30")];
    for (let i = 1; i < ACCOUNT_MAX_LONG_POLLS; i++) polls.push(call("/v1/inboxes/many/events?wait=30"));
    for (let i = 0; i < 200 && (await bridges()) < ACCOUNT_MAX_LONG_POLLS; i++) await sleep(10);
    expect(await bridges()).toBe(ACCOUNT_MAX_LONG_POLLS);

    const refused = await call("/v1/inboxes/one/events?wait=30");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(refused.headers.get("RateLimit-Limit")).toBe("120");
    expect(await refused.json()).toMatchObject({
      code: "too_many_connections",
      title: `Too many long polls waiting on this account (at most ${ACCOUNT_MAX_LONG_POLLS})`,
    });
    // One that needn't wait is answered anyway.
    expect((await call("/v1/inboxes/one/events?wait=0")).status).toBe(200);

    // One poll answered makes room for another.
    await inject("one");
    expect((await (await polls.shift()!).json<EventsPage>()).events).toHaveLength(1);
    for (let i = 0; i < 100 && (await bridges()) >= ACCOUNT_MAX_LONG_POLLS; i++) await sleep(10);
    polls.push(call("/v1/inboxes/many/events?wait=30"));
    for (let i = 0; i < 200 && (await bridges()) < ACCOUNT_MAX_LONG_POLLS; i++) await sleep(10);
    expect(await bridges()).toBe(ACCOUNT_MAX_LONG_POLLS);

    await inject("many");
    for (const res of await Promise.all(polls)) expect(res.status).toBe(200);
  });
});

describe("inboxes", () => {
  // An account of its own, so its list holds only this test's inboxes.
  let nextAccount = 7000;
  async function account() {
    const id = nextAccount++;
    const res = await exports.default.fetch(`${BASE}/debug/accounts/${id}/keys`, { method: "POST", headers: DEBUG });
    const auth = { Authorization: `Bearer ${(await res.json<LoginResponse>()).api_key}` };
    const call = (path: string, init: RequestInit = {}) =>
      exports.default.fetch(`${BASE}${path}`, { ...init, headers: { ...auth, ...init.headers } });
    const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName(`acct:${id}`));
    const inject = (inbox: string, count = 1) =>
      exports.default.fetch(`${BASE}/debug/accounts/${id}/inboxes/${inbox}/events`, { method: "POST", headers: DEBUG, body: JSON.stringify({ count }) });
    const info = async (inbox: string) => {
      const res = await call(`/v1/inboxes/${inbox}`);
      expect(res.status).toBe(200);
      return res.json<InboxInfo>();
    };
    return { call, stub, inject, info };
  }

  it("answers PUT, GET and the list with the whole inbox", async () => {
    const { call, stub, inject, info } = await account();
    const put = await call("/v1/inboxes/b", { method: "PUT" });
    expect(put.status).toBe(200);
    const made = await put.json<InboxInfo>();
    expect(made).toEqual({
      name: "b",
      created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      head: 0,
      acked: 0,
      oldest: 1,
      subscriptions: 0,
      last_read_at: null,
    });
    expect(await info("b")).toEqual(made);

    await inject("b", 3);
    await call("/v1/inboxes/b/ack", { method: "POST", body: JSON.stringify({ seq: 2 }) });
    // Looking at it isn't reading it.
    expect(await info("b")).toMatchObject({ head: 3, acked: 2, oldest: 1, last_read_at: null });
    await call("/v1/inboxes/b/events");
    expect((await info("b")).last_read_at).toEqual(expect.stringMatching(/^\d{4}-/));

    // Events too old to keep, though not yet deleted, don't count.
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec("UPDATE events SET at = ? WHERE inbox = 'b' AND seq <= 2", Date.now() - (INBOX_MAX_AGE_DAYS + 1) * 24 * 3600 * 1000);
      state.storage.sql.exec(
        "INSERT INTO subscriptions (id, inbox, repo_id, repo_name, private, pr, spec, created_at, expires_at) VALUES ('sub_x', 'b', 1, 'o/r', 0, 1, '{}', 0, 0)",
      );
    });
    expect(await info("b")).toMatchObject({ head: 3, oldest: 3, subscriptions: 1 });
    // With none kept, `oldest` is the seq the next event will have.
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec("DELETE FROM events WHERE inbox = 'b'");
    });
    expect(await info("b")).toMatchObject({ head: 3, oldest: 4 });

    expect((await call("/v1/inboxes/a", { method: "PUT" })).status).toBe(200);
    const listed = await call("/v1/inboxes");
    expect(listed.status).toBe(200);
    const { inboxes } = await listed.json<InboxesResponse>();
    expect(inboxes.map((i) => i.name)).toEqual(["a", "b"]);
    expect(inboxes[1]).toEqual(await info("b"));
  });

  it("404s for an inbox that doesn't exist, and lists none for a new account", async () => {
    const { call } = await account();
    expect(await (await call("/v1/inboxes")).json()).toEqual({ inboxes: [] });
    for (const method of ["GET", "DELETE"]) {
      const res = await call("/v1/inboxes/nope", { method });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: "not_found", title: "No such inbox" });
    }
  });

  it("deletes an inbox with its events, hangs up its sockets, and makes it again where it left off", async () => {
    const { call, stub, inject, info } = await account();
    expect((await call("/v1/inboxes/gone", { method: "PUT" })).status).toBe(200);
    expect((await call("/v1/inboxes/kept", { method: "PUT" })).status).toBe(200);
    await inject("gone", 4);
    await inject("kept", 1);
    await call("/v1/inboxes/gone/ack", { method: "POST", body: JSON.stringify({ seq: 1 }) });

    const res = await call("/v1/inboxes/gone/ws", { headers: { Upgrade: "websocket" } });
    const ws = res.webSocket!;
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.addEventListener("close", (ev) => resolve({ code: ev.code, reason: ev.reason })),
    );
    ws.accept();
    const poll = call("/v1/inboxes/gone/events?after=4&wait=30");
    await sleep(200);

    expect((await call("/v1/inboxes/gone", { method: "DELETE" })).status).toBe(204);
    expect(await closed).toEqual({ code: 4004, reason: "inbox deleted" });
    // The long poll waiting on it ends with nothing.
    expect((await (await poll).json<EventsPage>()).events).toEqual([]);
    expect((await call("/v1/inboxes/gone")).status).toBe(404);
    expect((await call("/v1/inboxes/gone/events")).status).toBe(404);
    expect((await call("/v1/inboxes/gone", { method: "DELETE" })).status).toBe(404);
    expect((await (await call("/v1/inboxes")).json<InboxesResponse>()).inboxes.map((i) => i.name)).toEqual(["kept"]);
    const rows = await runInDurableObject(stub, (_, state) =>
      state.storage.sql.exec<{ inbox: string }>("SELECT inbox FROM events ORDER BY inbox").toArray().map((r) => r.inbox),
    );
    expect(rows).toEqual(["kept"]);

    // Made again, its numbering carries on, as for an idle inbox.
    expect(await (await call("/v1/inboxes/gone", { method: "PUT" })).json()).toMatchObject({ head: 4, acked: 1, oldest: 5 });
    await inject("gone");
    expect((await info("gone")).head).toBe(5);

    // One that never had an event leaves nothing behind.
    expect((await call("/v1/inboxes/empty", { method: "PUT" })).status).toBe(200);
    expect((await call("/v1/inboxes/empty", { method: "DELETE" })).status).toBe(204);
    const remembered = await runInDurableObject(stub, (_, state) =>
      state.storage.sql.exec<{ name: string }>("SELECT name FROM deleted_inboxes").toArray().map((r) => r.name),
    );
    expect(remembered).toEqual([]);
  });

  it("doesn't let a long poll's bridge make a deleted inbox again", async () => {
    const { call, stub } = await account();
    expect((await call("/v1/inboxes/gone", { method: "PUT" })).status).toBe(200);
    expect((await call("/v1/inboxes/gone", { method: "DELETE" })).status).toBe(204);
    // As the Worker opens one after a read that found the inbox.
    const res = await stub.fetch("https://account/ws?inbox=gone&mode=bridge&after=0", { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(404);
    expect((await call("/v1/inboxes/gone")).status).toBe(404);
  });

  it(`moves oldest on as the inbox trims to ${INBOX_MAX_EVENTS} events`, async () => {
    const { call, inject, info } = await account();
    expect((await call("/v1/inboxes/full", { method: "PUT" })).status).toBe(200);
    // /debug injects at most 100 at a time.
    for (let n = 0; n < INBOX_MAX_EVENTS + 100; n += 100) await inject("full", 100);
    expect(await info("full")).toMatchObject({ head: INBOX_MAX_EVENTS + 100, oldest: 101 });
  });

  it("drops RepoHub's deliveries to a deleted inbox rather than make it again", async () => {
    const { call, stub } = await account();
    expect((await call("/v1/inboxes/gone", { method: "PUT" })).status).toBe(200);
    expect((await call("/v1/inboxes/gone", { method: "DELETE" })).status).toBe(204);
    const event = {
      v: 1 as const, id: "e1", sub: "sub_x", kind: "review.submitted", at: new Date().toISOString(), received_at: new Date().toISOString(),
      repo: null, pr: null, actor: null, data: {}, links: {},
    };
    expect(await stub.deliver([{ inbox: "gone", event }], false)).toEqual({ delivered: 0, duplicates: 0, dropped: 1 });
    expect((await call("/v1/inboxes/gone")).status).toBe(404);
    // /debug still makes inboxes as it goes.
    expect(await stub.deliver([{ inbox: "gone", event }])).toEqual({ delivered: 1, duplicates: 0, dropped: 0 });
    expect((await call("/v1/inboxes/gone")).status).toBe(200);
  });
});
