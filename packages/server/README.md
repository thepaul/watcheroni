# @watcheroni/server (prototype)

The first roadmap step from [DESIGN.md](../../DESIGN.md): a Worker and one
`Account` Durable Object with hibernated WebSockets and the long-poll
bridge. Its purpose is to confirm that the object hibernates, and isn't
billed for waiting, on Cloudflare's free plan.

What's here, compared with the full design:

- **Implemented:** inboxes, numbered events with dedupe by `id`, `ack`,
  `GET .../events?after=&wait=&limit=` long-polling through the Worker
  bridge, the WebSocket protocol (`hello`, `ready`, `events`, `ack`,
  `ping`/`pong` answered by the runtime), and the `watcheroni.v1`
  subprotocol.
- **Stand-ins:** one shared `PROTO_TOKEN` instead of login and API keys
  (sent as `Authorization: Bearer`, or `?token=` on the WebSocket instead
  of tickets); `POST /debug/inboxes/{name}/events` instead of webhooks and
  RepoHub; `GET /debug/stats` to see what the object is doing.
- **Not yet:** RepoHub, Installation, Control, GitHub, limits, `inbox.gap`.

## Develop

```
npm install           # from the repository root
cp .dev.vars.example .dev.vars   # and set PROTO_TOKEN
npm test              # Vitest inside workerd, including a forced eviction
npm run dev           # wrangler dev on http://localhost:8787
```

## Confirm hibernation on Cloudflare

1. Sign in and deploy (the free plan is enough):

   ```
   npx wrangler login
   npx wrangler secret put PROTO_TOKEN
   npm run deploy
   ```

   Keep the token and URL in `.deploy.vars` (gitignored) as
   `PROTO_TOKEN=...` and `URL=...`; the probe reads `PROTO_TOKEN` from the
   environment, so `set -a; . ./.deploy.vars; set +a` saves typing it.

2. Run the probe against the deployed Worker. It opens WebSocket clients
   and a long-poll, leaves them idle, injects an event, and reports
   whether the object's instance changed (it left memory) while every
   socket stayed open:

   ```
   npm run probe -- --url https://watcheroni-proto.<subdomain>.workers.dev \
     --token <PROTO_TOKEN> --clients 3 --idle 180
   ```

   `PASS` means the object hibernated and every waiter was woken.
   `INCONCLUSIVE` means it stayed in memory; Cloudflare doesn't promise
   when it hibernates, so try a longer idle.

3. Check the billing side a few minutes later. Create an API token with
   **Account Analytics: Read**, then:

   ```
   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
     npm run usage -- --since <time the probe started, ISO 8601>
   ```

   This lists per-minute Durable Object usage. During the probe's idle
   minutes, active time and CPU should be at or near zero although the
   sockets were open.

Live logs while probing: `npx wrangler tail`.

## Result so far

Locally (`wrangler dev`, workerd 1.20261023.1), on 2026-10-26: with three
WebSocket clients and a long-poll bridge attached, the object was evicted
within a 15-second idle, keepalive pings didn't wake it, and all four
waiters received the next event within 15 ms.

On Cloudflare (free plan, `watcheroni-proto.shinycode.workers.dev`), on
2026-10-27 at 01:22 UTC: three WebSocket clients and a long-poll held by
the Worker for 182 s. The object was evicted during the 180-second idle,
18 keepalive pings didn't wake it, no client socket dropped, and all four
waiters received the injected event within 90 ms. PASS. The billing check
(`npm run usage`) hasn't been run yet.
