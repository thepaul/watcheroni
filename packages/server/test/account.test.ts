import { evictDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AccountStats } from "../src/account";
import type { EventsPage, ServerMessage } from "../src/protocol";

const BASE = "https://watcheroni.test";
const AUTH = { Authorization: "Bearer test-token" };

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
  return call(`/debug/inboxes/${inbox}/events`, { method: "POST", body: JSON.stringify(body) });
}

async function stats(): Promise<AccountStats> {
  return (await call("/debug/stats")).json();
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

describe("auth", () => {
  it("rejects requests without the token", async () => {
    const res = await exports.default.fetch(`${BASE}/v1/inboxes/x`, { method: "PUT" });
    expect(res.status).toBe(401);
    expect((await res.json<{ code: string }>()).code).toBe("unauthorized");
  });

  it("serves /v1/meta without auth", async () => {
    const res = await exports.default.fetch(`${BASE}/v1/meta`);
    expect((await res.json<{ protocol: number }>()).protocol).toBe(1);
  });
});

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
    const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName("acct:proto"));

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
