import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AccountStats } from "../src/account";
import {
  ACCOUNT_MAX_INBOXES,
  ACCOUNT_MAX_LONG_POLLS,
  ACCOUNT_MAX_SOCKETS,
  INBOX_IDLE_DAYS,
  type EventsPage,
  type LoginResponse,
  type ServerMessage,
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

  it("pushes nothing before hello", async () => {
    const inbox = await newInbox();
    const c = await connect(inbox);
    await inject(inbox);
    await sleep(100);
    expect(c.messages).toEqual([]);
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
