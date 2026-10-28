# @watcheroni/server (prototype)

The first roadmap step from [DESIGN.md](../../DESIGN.md): a Worker and
`Account` Durable Objects (one per GitHub user) with hibernated
WebSockets and the long-poll bridge. Its purpose is to confirm that the object hibernates, and isn't
billed for waiting, on Cloudflare's free plan.

What's here, compared with the full design:

- **Implemented:** sign-in (`POST /v1/login` checks a GitHub App user
  token with GitHub and issues an API key, of which only a SHA-256 hash is
  stored in that user's `acct:<id>` object), `GET /v1/keys`,
  `DELETE /v1/keys/{id|current}`, the `POST /v1/github/refresh` proxy,
  WebSocket tickets (`TICKET_KEY`, `TICKET_KEY_OLD` for rotation) and the
  per-account limit of 120 requests a minute. Inboxes, numbered events
  with dedupe by `id`, `ack`, `GET .../events?after=&wait=&limit=`
  long-polling through the Worker bridge, the WebSocket protocol (`hello`,
  `ready`, `events`, `ack`, `ping`/`pong` answered by the runtime), and
  the `watcheroni.v1` subprotocol. `POST /github/webhook` checks GitHub's
  signature and normalises the payload into events, but routes them
  nowhere yet (the response lists them).
- **Stand-ins:** with `DEBUG_TOKEN` set, `/debug/accounts/{id}/...` mints
  keys without GitHub, injects events instead of webhooks and RepoHub,
  and shows what an object is doing (see "Worker routes" in DESIGN.md).
- **Not yet:** RepoHub, Installation, Control, the per-IP limit on
  `/v1/login` and `/v1/github/refresh`, revoking keys on the
  `github_app_authorization` webhook (`Account.revokeAllKeys` is ready for
  it), `inbox.gap`. No GitHub App is registered yet, so `GITHUB_CLIENT_ID`
  is empty and login answers 503; the tests stub GitHub.

## Develop

```
npm install           # from the repository root
cp .dev.vars.example .dev.vars   # and set TICKET_KEY and DEBUG_TOKEN
npm test              # Vitest inside workerd, including a forced eviction
npm run dev           # wrangler dev on http://localhost:8787
```

## Deploy

There are two Workers, with separate Durable Objects and secrets:

- **Test:** `watcheroni-proto` on `https://watcheroni-proto.shinycode.workers.dev`,
  with the `/debug` routes on. `npm run deploy` and plain `wrangler`
  commands go here.
- **Production:** `watcheroni` on `https://watcheroni.dev`, the CLI's
  default server, with no `DEBUG_TOKEN`. `npm run deploy:production`, and
  `--env production` on `wrangler secret put` and the like.

The GitHub App's webhook can point at only one of them; it points at
production.

## Confirm hibernation on Cloudflare

1. Sign in and deploy (the free plan is enough):

   ```
   npx wrangler login
   npx wrangler secret put TICKET_KEY
   npx wrangler secret put DEBUG_TOKEN
   npm run deploy
   ```

   Keep the token and URL in `.deploy.vars` (gitignored) as
   `DEBUG_TOKEN=...` and `URL=...`; the probe reads `DEBUG_TOKEN` from the
   environment, so `set -a; . ./.deploy.vars; set +a` saves typing it.
   (`PROTO_TOKEN` from earlier deploys is no longer used:
   `npx wrangler secret delete PROTO_TOKEN`.)

2. Run the probe against the deployed Worker. It opens WebSocket clients
   and a long-poll, leaves them idle, injects an event, and reports
   whether the object's instance changed (it left memory) while every
   socket stayed open:

   ```
   npm run probe -- --url https://watcheroni-proto.<subdomain>.workers.dev \
     --debug-token <DEBUG_TOKEN> --clients 3 --idle 180
   ```

   `PASS` means the object hibernated and every waiter was woken.
   `INCONCLUSIVE` means it stayed in memory; Cloudflare doesn't promise
   when it hibernates, so try a longer idle.

3. Check the billing side a few minutes later (analytics can lag by ten
   minutes or more). The script uses wrangler's login, or
   `CLOUDFLARE_API_TOKEN` if set; your account ID is in
   `npx wrangler whoami`:

   ```
   CLOUDFLARE_ACCOUNT_ID=... \
     npm run usage -- --since <time the probe started, ISO 8601>
   ```

   This lists per-minute Durable Object usage. During the probe's idle
   minutes, active time and CPU should be at or near zero although the
   sockets were open.

Live logs while probing: `npx wrangler tail`.

## Measure webhook CPU

Set `GITHUB_WEBHOOK_SECRET` on the Worker (`npx wrangler secret put`),
then:

```
node scripts/webhook-cpu.mjs --url https://watcheroni-proto.<subdomain>.workers.dev \
  --secret <GITHUB_WEBHOOK_SECRET> --repeat 15
```

It sends GitHub's example payloads and enlarged copies of them, and
reads each request's CPU time from `wrangler tail`. Tail samples, so it
usually sees about half the requests. Results are in DESIGN.md under
"Webhook CPU".

## Result so far

Locally (`wrangler dev`, workerd 1.20261023.1), on 2026-10-26: with three
WebSocket clients and a long-poll bridge attached, the object was evicted
within a 15-second idle, keepalive pings didn't wake it, and all four
waiters received the next event within 15 ms.

On Cloudflare (free plan, `watcheroni-proto.shinycode.workers.dev`), on
2026-10-27 at 01:22 UTC: three WebSocket clients and a long-poll held by
the Worker for 182 s. The object was evicted during the 180-second idle,
18 keepalive pings didn't wake it, no client socket dropped, and all four
waiters received the injected event within 90 ms. PASS.

With real sign-in (2026-10-27, after the RepoHub, sign-in and CLI
server-mode merges): the same probe, now authenticating with an API key
minted through `/debug` and WebSocket tickets, passed again, with all
waiters woken within 97 ms. A signed `pull_request_review` webhook for a
subscribed PR went through RepoHub to the inbox (`delivered: 1`), and
`watcheroni wait` in server mode printed it and acknowledged it. GitHub
accepted the App's device flow (`watcheroni login` got a code); finishing
sign-in needs a person at github.com/login/device.

Billing for the first run, from `npm run usage` (activeTime in microseconds,
duration in GB-s):

| Minute (UTC) | activeTime | cpuTime | duration | What happened |
|---|---|---|---|---|
| 01:22 | 194,753 | 9,883 | 0.0249 | sockets opened, bridge attached |
| 01:23 | no row | | | idle, 4 sockets open |
| 01:24 | no row | | | idle, 4 sockets open |
| 01:25 | 41,119 | 3,796 | 0.0053 | event injected, all woken |

Nothing was billed while the object hibernated. The whole run cost
0.03 GB-s of the free plan's 13,000 GB-s a day.
