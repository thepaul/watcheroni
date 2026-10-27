#!/usr/bin/env node
// Hibernation probe for the deployed prototype.
//
// Opens WebSocket clients and one long-poll on a fresh inbox, leaves
// everything idle, then injects an event and checks:
//   - every client and the long-poll received it;
//   - the Account object is a different instance afterwards (it was
//     evicted from memory while the sockets stayed open: hibernation);
//   - nothing woke it during the idle period (keepalive pings are answered
//     by the runtime).
//
// Usage:
//   node scripts/probe.mjs --url https://watcheroni-proto.<you>.workers.dev \
//     --debug-token <DEBUG_TOKEN> [--account 0] [--clients 3] [--idle 120]
//
// It mints an API key for --account through /debug (account 0 is never a
// real GitHub user), and connects its WebSockets with tickets.
//
// Needs Node.js 22 or later (built-in fetch and WebSocket).

import { parseArgs } from "node:util";

const { values: opts } = parseArgs({
  options: {
    url: { type: "string" },
    "debug-token": { type: "string", default: process.env.DEBUG_TOKEN },
    account: { type: "string", default: "0" },
    clients: { type: "string", default: "3" },
    idle: { type: "string", default: "120" },
    "ping-every": { type: "string", default: "30" },
  },
});
if (!opts.url || !opts["debug-token"]) {
  console.error("usage: probe.mjs --url <worker url> --debug-token <DEBUG_TOKEN> [--account ID] [--clients N] [--idle SECONDS]");
  process.exit(2);
}
const base = opts.url.replace(/\/$/, "");
const clients = Number(opts.clients);
const idle = Number(opts.idle);
const pingEvery = Number(opts["ping-every"]);
const longPollWait = Math.min(idle + 60, 300);
if (idle + 30 > longPollWait) {
  console.error(`--idle ${idle} is too long for a ${longPollWait}s long-poll; use at most 240`);
  process.exit(2);
}

const call = async (auth, method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${auth}`, "content-type": "application/json" },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
};
const debugBase = `/debug/accounts/${opts.account}`;
const debug = (method, path, body) => call(opts["debug-token"], method, `${debugBase}${path}`, body);
const { api_key: apiKey, key_id: keyId } = await debug("POST", "/keys", { label: "probe" });
const api = (method, path, body) => call(apiKey, method, path, body);
const headers = { Authorization: `Bearer ${apiKey}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const inbox = `probe-${Date.now()}`;
await api("PUT", `/v1/inboxes/${inbox}`);
log(`inbox ${inbox}`);

// WebSocket clients, each with its own ticket.
const tickets = await Promise.all(Array.from({ length: clients }, () => api("POST", `/v1/inboxes/${inbox}/ticket`)));
const sockets = await Promise.all(
  tickets.map(({ url }, i) => new Promise((resolve, reject) => {
    const ws = new WebSocket(url, "watcheroni.v1");
    const state = { i, ws, events: [], pongs: 0, closed: null, receivedAt: null };
    ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "hello" })));
    ws.addEventListener("message", (ev) => {
      if (ev.data === "pong") return void state.pongs++;
      const msg = JSON.parse(ev.data);
      if (msg.type === "ready") resolve(state);
      if (msg.type === "events") {
        state.events.push(...msg.events);
        state.receivedAt ??= Date.now();
      }
    });
    ws.addEventListener("close", (ev) => { state.closed = `${ev.code} ${ev.reason}`; });
    ws.addEventListener("error", () => reject(new Error(`client ${i} failed to connect`)));
  })),
);
log(`${clients} WebSocket clients ready`);
const pinger = setInterval(() => sockets.forEach((s) => s.ws.readyState === 1 && s.ws.send("ping")), pingEvery * 1000);

// One long-poll, held by the Worker through the bridge.
const pollStarted = Date.now();
const poll = fetch(`${base}/v1/inboxes/${inbox}/events?wait=${longPollWait}`, { headers })
  .then(async (r) => ({ status: r.status, body: await r.json(), at: Date.now() }));
await sleep(2000);

const before = await debug("GET", "/stats");
const bridges = before.sockets.filter((s) => s.inbox === inbox && s.mode === "bridge").length;
log(`instance before idle: ${before.instance} (${bridges} bridge socket, ${before.sockets.length} sockets in all)`);

log(`idle for ${idle}s, pinging every ${pingEvery}s...`);
const idleStart = Date.now();
await sleep(idle * 1000);
const idleEnd = Date.now();

const injectedAt = Date.now();
await debug("POST", `/inboxes/${inbox}/events`, { kind: "probe.wake" });
log("event injected");

const pollResult = await Promise.race([poll, sleep(15000).then(() => null)]);
await sleep(2000);
clearInterval(pinger);
const after = await debug("GET", "/stats");
sockets.forEach((s) => s.ws.close(1000));
await api("DELETE", `/v1/keys/${keyId}`).catch(() => {});

const wakesDuringIdle = after.wakes.filter((w) => {
  const t = Date.parse(w.at);
  return t >= idleStart && t < idleEnd;
});
const clientsGotIt = sockets.filter((s) => s.events.some((e) => e.kind === "probe.wake"));
const pollGotIt = pollResult?.body?.events?.some((e) => e.kind === "probe.wake");
const hibernated = after.instance !== before.instance;

console.log();
console.log(`clients received the event:   ${clientsGotIt.length}/${clients}` +
  (clientsGotIt.length ? ` (after ${Math.max(...clientsGotIt.map((s) => s.receivedAt - injectedAt))} ms at most)` : ""));
console.log(`long-poll received the event: ${pollGotIt ? `yes (after ${pollResult.at - injectedAt} ms; held ${Math.round((pollResult.at - pollStarted) / 1000)}s)` : `no (${pollResult ? `status ${pollResult.status}` : "no answer"})`}`);
console.log(`pongs received:               ${sockets.reduce((n, s) => n + s.pongs, 0)}`);
console.log(`client sockets closed early:  ${sockets.filter((s) => s.closed).map((s) => `#${s.i}: ${s.closed}`).join(", ") || "none"}`);
console.log(`object woken during idle:     ${wakesDuringIdle.length ? `${wakesDuringIdle.length} times` : "no"}`);
console.log(`instance changed (hibernated): ${hibernated ? "YES" : "no"}  ${before.instance} -> ${after.instance}`);
console.log();
if (hibernated && clientsGotIt.length === clients && pollGotIt) {
  console.log("PASS: the object left memory while every socket stayed open, and all of them were woken.");
  console.log("Confirm the billing side with: npm run usage -- --since <start time>");
} else if (!hibernated) {
  console.log("INCONCLUSIVE: the object stayed in memory. Cloudflare doesn't promise when it hibernates;");
  console.log("try a longer --idle, and check that nothing else is calling the Worker.");
  process.exitCode = 1;
} else {
  console.log("FAIL: the object hibernated but not every waiter was woken.");
  process.exitCode = 1;
}
