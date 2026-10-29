import examples from "@octokit/webhooks-examples/api.github.com/index.json";
import { createScheduledController, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REDELIVERY_LIMITS, nextLink, retryable, type Control, type ControlStats } from "../src/control";
import type { WatchEvent } from "../src/protocol";
import { sign } from "../src/webhook/signature";
import worker from "../src/worker";

const BASE = "https://watcheroni.test";
const DEBUG = { Authorization: "Bearer test-debug-token" };
const API = "https://api.github.com";

let counter = 0;
const fresh = () => 600_000_000 + Math.floor(Math.random() * 1_000_000) * 100 + counter++;

// A Control object of its own for each test; the cron's is named `control`.
const control = (name = `test-${fresh()}`) => env.CONTROL.get(env.CONTROL.idFromName(name));

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- A stand-in for GitHub's webhook deliveries ----------------------

interface FakeDelivery {
  id: number;
  guid: string;
  delivered_at: string;
  redelivery: boolean;
  status_code: number;
  event: string;
  // What the webhook carried, for redelivering it to the Worker.
  body?: { event: string; payload: unknown };
}

class FakeHooks {
  deliveries: FakeDelivery[] = [];
  private nextId = 5_000_000;
  // Calls seen, and which ones to fail.
  lists = 0;
  failList: (n: number) => boolean = () => false;
  redelivered: number[] = [];
  redeliverStatus = 202;
  // The status a redelivery itself gets. By default it succeeds.
  outcome: (d: FakeDelivery) => Promise<number> = async () => 200;

  // A delivery `ageMs` ago. IDs grow with each one added, as on GitHub.
  add(status: number, ageMs = 5 * 60_000, guid: string = crypto.randomUUID(), body?: FakeDelivery["body"]): FakeDelivery {
    const d: FakeDelivery = {
      id: this.nextId++,
      guid,
      delivered_at: new Date(Date.now() - ageMs).toISOString(),
      redelivery: false,
      status_code: status,
      event: body?.event ?? "issue_comment",
      body,
    };
    this.deliveries.push(d);
    return d;
  }

  install(): void {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.origin !== API) throw new Error(`unexpected fetch ${req.url}`);
      if ((req.headers.get("Authorization") ?? "").split(".").length !== 3) return Response.json({}, { status: 401 });
      if (req.method === "GET" && url.pathname === "/app/hook/deliveries") return this.list(url);
      const m = url.pathname.match(/^\/app\/hook\/deliveries\/(\d+)\/attempts$/);
      if (req.method === "POST" && m) return this.redeliver(Number(m[1]));
      throw new Error(`unexpected fetch ${req.method} ${req.url}`);
    });
  }

  // Newest first; `cursor` is the ID a page starts at.
  private list(url: URL): Response {
    if (this.failList(++this.lists)) return Response.json({ message: "Server Error" }, { status: 502 });
    const perPage = Number(url.searchParams.get("per_page") ?? 30);
    const start = Number(url.searchParams.get("cursor") ?? Infinity);
    const sorted = [...this.deliveries].sort((a, b) => b.id - a.id).filter((d) => d.id <= start);
    const page = sorted.slice(0, perPage);
    const headers = new Headers();
    if (sorted.length > perPage) {
      headers.set("Link", `<${API}/app/hook/deliveries?per_page=${perPage}&cursor=${sorted[perPage].id}>; rel="next"`);
    }
    return Response.json(page.map(({ body: _, ...d }) => ({ ...d, duration: 0.1, status: "", action: null, installation_id: 1, repository_id: 1 })), { headers });
  }

  private async redeliver(id: number): Promise<Response> {
    const original = this.deliveries.find((d) => d.id === id);
    if (!original) return Response.json({ message: "Not Found" }, { status: 404 });
    if (this.redeliverStatus !== 202) return Response.json({}, { status: this.redeliverStatus });
    this.redelivered.push(id);
    // A redelivery is a new delivery with the same GUID. Dated a little
    // back, so the next scan doesn't wait for it to settle.
    const status = await this.outcome(original);
    const d = this.add(status, 2 * 60_000, original.guid, original.body);
    d.redelivery = true;
    return Response.json({}, { status: 202 });
  }
}

function hooks(): FakeHooks {
  const gh = new FakeHooks();
  gh.install();
  return gh;
}

const guidsOf = (gh: FakeHooks, ids: number[]) => ids.map((id) => gh.deliveries.find((d) => d.id === id)!.guid);

async function setCursor(stub: DurableObjectStub<Control>, cursor: number): Promise<void> {
  await runInDurableObject(stub, (_: Control, state) => {
    state.storage.sql.exec("INSERT INTO meta (k, v) VALUES ('cursor', ?)", String(cursor));
  });
}

describe("helpers", () => {
  it("redelivers only what could succeed next time", () => {
    expect([0, 429, 500, 502, 503, 504].every(retryable)).toBe(true);
    expect([200, 202, 400, 401, 404, 413].some(retryable)).toBe(false);
  });

  it("follows only GitHub's own next links", () => {
    expect(nextLink(`<${API}/app/hook/deliveries?cursor=a>; rel="next", <${API}/x>; rel="prev"`)).toBe(`${API}/app/hook/deliveries?cursor=a`);
    expect(nextLink(`<https://evil.example/x>; rel="next"`)).toBeNull();
    expect(nextLink(null)).toBeNull();
  });
});

describe("redelivery", () => {
  it("redelivers deliveries that failed, and only those", async () => {
    const gh = hooks();
    const old = gh.add(503, 2 * 3600_000); // before the first run's lookback
    const ok = gh.add(200);
    const refused = gh.add(401);
    const failed = [gh.add(502), gh.add(0), gh.add(429)];
    const recovered = gh.add(500, 4 * 60_000);
    gh.add(200, 3 * 60_000, recovered.guid).redelivery = true;
    const inFlight = gh.add(504, 10_000); // too new; next run
    const stub = control();

    const run = await stub.redeliver();
    expect(run).toMatchObject({ pages: 1, queued: 3, redelivered: 3, pending: 0, caught_up: true });
    expect(gh.redelivered).toEqual(failed.map((d) => d.id));
    // The cursor is the newest delivery that had settled.
    expect(run.cursor).toBe(inFlight.id - 1);
    expect(gh.redelivered).not.toContain(old.id);
    expect(gh.redelivered).not.toContain(ok.id);
    expect(gh.redelivered).not.toContain(refused.id);

    // Next run: the in-flight one, and the redeliveries, which succeeded.
    gh.redelivered = [];
    const again = await stub.redeliver();
    expect(gh.redelivered).toEqual([inFlight.id]);
    expect(again).toMatchObject({ redelivered: 1, pending: 0, caught_up: true });
    const stats: ControlStats = await stub.stats();
    expect(stats.attempts.map((a) => a.n)).toEqual([1, 1, 1, 1]);
  });

  it("pages back to the cursor, carrying a long scan over to the next run", async () => {
    const gh = hooks();
    const stub = control();
    const before = gh.add(500, 30 * 60_000); // already covered
    await setCursor(stub, before.id);
    const firstFailure = gh.add(500, 20 * 60_000);
    for (let i = 0; i < 449; i++) gh.add(200, 15 * 60_000);
    const lastFailure = gh.add(503, 10 * 60_000);

    const one = await stub.redeliver();
    expect(one).toMatchObject({ pages: REDELIVERY_LIMITS.pages, scanned: 300, caught_up: false, cursor: before.id });
    expect(gh.redelivered).toEqual([lastFailure.id]);

    // Deliveries since the scan began wait for the next one.
    const later = gh.add(500, 5 * 60_000);
    const two = await stub.redeliver();
    expect(two).toMatchObject({ pages: 2, scanned: 151, caught_up: true, cursor: lastFailure.id });
    expect(gh.redelivered).toEqual([lastFailure.id, firstFailure.id]);

    const three = await stub.redeliver();
    expect(three).toMatchObject({ pages: 1, caught_up: true });
    expect(gh.redelivered).toEqual([lastFailure.id, firstFailure.id, later.id]);
    expect(three.cursor).toBeGreaterThan(later.id);
  });

  it("caps redeliveries per run and carries on next run", async () => {
    const gh = hooks();
    const failures = Array.from({ length: 15 }, () => gh.add(502));
    const stub = control();

    const one = await stub.redeliver();
    expect(one).toMatchObject({ queued: 15, redelivered: REDELIVERY_LIMITS.redeliveries, pending: 5 });
    const two = await stub.redeliver();
    expect(two).toMatchObject({ redelivered: 5, pending: 0 });
    // Oldest first, each once.
    expect(gh.redelivered).toEqual(failures.map((d) => d.id));
  });

  it("keeps its cursor and queue through a failed run", async () => {
    const gh = hooks();
    const stub = control();
    const before = gh.add(200, 50 * 60_000);
    await setCursor(stub, before.id);
    const failures = [gh.add(500, 40 * 60_000), gh.add(500, 30 * 60_000)];
    for (let i = 0; i < 150; i++) gh.add(200, 20 * 60_000);

    // GitHub fails the second page.
    gh.failList = (n) => n === 2;
    const one = await stub.redeliver();
    expect(one).toMatchObject({ pages: 1, caught_up: false, cursor: before.id, redelivered: 0 });
    expect(one.error).toMatch(/502/);
    expect((await stub.stats()).meta.last_error).toMatch(/502/);

    // GitHub accepts no redeliveries either.
    gh.failList = () => false;
    gh.redeliverStatus = 503;
    const two = await stub.redeliver();
    expect(two).toMatchObject({ pages: 1, caught_up: true, queued: 2, redelivered: 0, pending: 2 });
    expect(two.error).toMatch(/503/);

    gh.redeliverStatus = 202;
    const three = await stub.redeliver();
    expect(three).toMatchObject({ redelivered: 2, pending: 0 });
    expect(three.error).toBeUndefined();
    expect(gh.redelivered).toEqual(failures.map((d) => d.id));
    expect((await stub.stats()).meta.last_error).toBeUndefined();
  });

  it("gives up on a delivery after a few redeliveries", async () => {
    const gh = hooks();
    gh.outcome = async () => 500;
    const d = gh.add(500);
    const stub = control();
    for (let i = 0; i < REDELIVERY_LIMITS.attempts + 2; i++) await stub.redeliver();
    expect(gh.redelivered).toHaveLength(REDELIVERY_LIMITS.attempts);
    expect(guidsOf(gh, gh.redelivered)).toEqual(Array(REDELIVERY_LIMITS.attempts).fill(d.guid));
  });

  it("drops a delivery GitHub won't redeliver", async () => {
    const gh = hooks();
    gh.add(500);
    gh.redeliverStatus = 404;
    const stub = control();
    expect(await stub.redeliver()).toMatchObject({ redelivered: 0, pending: 0 });
    expect(await stub.redeliver()).toMatchObject({ queued: 0, pending: 0 });
  });

  it("reports an App that isn't configured", async () => {
    hooks();
    const stub = control();
    await runInDurableObject(stub, (instance: Control) => {
      (instance as unknown as { env: Env }).env = { ...env, GITHUB_APP_PRIVATE_KEY: "" };
    });
    expect((await stub.redeliver()).error).toMatch(/isn't configured/);
  });
});

describe("end to end", () => {
  type Example = { action?: string; [key: string]: unknown };
  const example = (event: string, action: string): Example =>
    structuredClone((examples as { name: string; examples: Example[] }[]).find((e) => e.name === event)!.examples.find((e) => e.action === action)!);

  async function post(guid: string, event: string, payload: unknown): Promise<number> {
    const body = new TextEncoder().encode(JSON.stringify(payload));
    const res = await exports.default.fetch(`${BASE}/github/webhook`, {
      method: "POST",
      headers: { "X-GitHub-Event": event, "X-GitHub-Delivery": guid, "X-Hub-Signature-256": await sign(body, "test-secret") },
      body,
    });
    return res.status;
  }

  it("a delivery that got a 5xx reaches the inbox once, from the cron job", async () => {
    const repo = fresh();
    const acct = fresh();
    const payload = example("pull_request_review", "submitted");
    (payload.repository as { id: number }).id = repo;
    const pr = (payload.pull_request as { number: number }).number;
    const sub = await exports.default.fetch(`${BASE}/debug/repos/${repo}/subscriptions`, {
      method: "POST",
      headers: DEBUG,
      body: JSON.stringify({ account: acct, inbox: "i", pr, full_name: "octo/widgets" }),
    });
    expect(sub.status).toBe(201);

    const gh = hooks();
    gh.outcome = (d) => post(d.guid, d.body!.event, d.body!.payload);
    // The Worker was down for this one; this one arrived; and one more
    // that arrived but whose response was lost.
    const lost = gh.add(503, 5 * 60_000, crypto.randomUUID(), { event: "pull_request_review", payload });
    const arrived = gh.add(await post(crypto.randomUUID(), "pull_request_review", payload), 4 * 60_000);
    const both = crypto.randomUUID();
    expect(await post(both, "pull_request_review", payload)).toBe(202);
    gh.add(502, 3 * 60_000, both, { event: "pull_request_review", payload });
    expect(arrived.status_code).toBe(202);

    // The cron job, as the runtime calls it, on the `control` object.
    await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: "*/10 * * * *" }), env);
    expect(gh.redelivered).toEqual([lost.id, gh.deliveries.find((d) => d.guid === both && !d.redelivery)!.id]);

    const page = await env.ACCOUNT.get(env.ACCOUNT.idFromName(`acct:${acct}`)).readEvents("i", 0, 100);
    const events: WatchEvent[] = page!.events;
    // One event per GUID: the lost one, redelivered; the one that
    // arrived; and the one that arrived and was redelivered anyway, its
    // duplicate dropped.
    expect(events).toHaveLength(3);
    expect(new Set(events.map((e) => e.id)).size).toBe(3);

    const stats = await exports.default.fetch(`${BASE}/debug/control`, { headers: DEBUG });
    expect((await stats.json<ControlStats>()).meta.cursor).toBeDefined();
  });
});
