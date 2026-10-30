# @watcheroni/server (prototype)

The first roadmap step from [DESIGN.md](../../DESIGN.md): a Worker and
`Account` Durable Objects (one per GitHub user) with hibernated
WebSockets and the long-poll bridge. Its purpose is to confirm that the object hibernates, and isn't
billed for waiting, on Cloudflare's free plan.

What's here, compared with the full design:

- **Implemented:** sign-in (`POST /v1/login` checks a GitHub App user
  token with GitHub and issues an API key, of which only a SHA-256 hash is
  stored in that user's `acct:<id>` object, and which carries an HMAC
  tag under `API_KEY_SECRET` so made-up keys never reach a Durable
  Object), `GET /v1/keys`,
  `DELETE /v1/keys/{id|current}`, the `POST /v1/github/refresh` proxy,
  WebSocket tickets (`TICKET_KEY`, `TICKET_KEY_OLD` for rotation) and the
  per-account limit of 120 requests a minute. Inboxes, numbered events
  with dedupe by `id`, `ack`, `GET .../events?after=&wait=&limit=`
  long-polling through the Worker bridge, the WebSocket protocol (`hello`,
  `ready`, `events`, `ack`, `ping`/`pong` answered by the runtime), and
  the `watcheroni.v1` subprotocol. `POST /github/webhook` checks GitHub's
  signature, normalises the payload into events and hands them to
  RepoHub; `installation` and `installation_repositories` go to
  Installation instead. `POST / GET / DELETE /v1/inboxes/{name}/subscriptions`
  check the App's installation (and, for private repos, the user's own
  token), take a PR baseline with the installation token and subscribe
  RepoHub. The Installation object signs App JWTs and caches installation
  tokens encrypted with `STORAGE_KEY`.
- **Stand-ins:** with `DEBUG_TOKEN` set, `/debug/accounts/{id}/...` mints
  keys without GitHub and injects events instead of webhooks and RepoHub,
  `/debug/repos/{id}/subscriptions` subscribes without the GitHub checks,
  and `/debug/{accounts,repos,installations}/{id}` show what an object is
  doing (see "Worker routes" in DESIGN.md).
- **Not yet:** Control, re-verifying private
  subscriptions (`/verify`), expiring subscriptions, the per-IP limit on
  `/v1/login` and `/v1/github/refresh`, revoking keys on the
  `github_app_authorization` webhook (`Account.revokeAllKeys` is ready for
  it), `inbox.gap`. The tests stub GitHub.

## Develop

```
npm install           # from the repository root
cp .dev.vars.example .dev.vars   # and set the secrets it lists
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
production. Its slug, for the install link, is the `GITHUB_APP_SLUG`
var.

Both need `STORAGE_KEY` (32 random bytes, base64) for the cached
installation tokens; without it they're cached in memory only:

```
openssl rand -base64 32 | tr -d '\n' | npx wrangler secret put STORAGE_KEY
openssl rand -base64 32 | tr -d '\n' | npx wrangler secret put STORAGE_KEY --env production
```

And `API_KEY_SECRET` (the same), the HMAC key for the tag on API keys.
Without it, login and `/debug` key minting answer 503 and no key is
accepted. Changing it invalidates every key issued under the old one,
so set it once:

```
openssl rand -base64 32 | tr -d '\n' | npx wrangler secret put API_KEY_SECRET
openssl rand -base64 32 | tr -d '\n' | npx wrangler secret put API_KEY_SECRET --env production
```

## Run your own

To run your own server, with your own GitHub App, on your own Cloudflare
account (the free plan is enough), from the root of a clone:

```
npm install
npm run selfhost -- --dry-run   # what it will do, changing nothing
npm run selfhost                # or `watcheroni selfhost`
```

It signs you in to Cloudflare if needed, deploys the Worker (named
`watcheroni` unless `--name`) to learn its workers.dev URL, opens your
browser at a pre-filled GitHub "create App" page (`--org ORG` for an
organization's App, `--public` to let anyone install it), sets the
secrets, deploys again with the App's ID, client ID and slug, asks you
to tick "Enable Device Flow" on the App's settings page, and points the
CLI at the new server. Then install the App on your repositories (it
prints the link), and `npx watcheroni login` and `npx watcheroni wait`.
Anyone else using your server sets `WATCHERONI_SERVER` to its URL.

It needs Node.js 22.18 or later. With several Cloudflare accounts, set
`CLOUDFLARE_ACCOUNT_ID` to choose one; the account is written into the
configuration, and later runs keep to it.

It's a script here rather than part of the published CLI because it
deploys this source with this package's wrangler, so it needs a clone
anyway; `watcheroni selfhost` just runs it from the clone you're in.

The Worker's configuration is `wrangler.selfhost.json` (gitignored),
made from `wrangler.jsonc`'s production settings with your name and
App. After a `git pull`, redeploy with `npm run selfhost -- --update`,
which remakes it and sets any secret the new version needs that the
Worker doesn't have yet (such as `API_KEY_SECRET`). Other wrangler commands take `-c
wrangler.selfhost.json`, e.g. `npx wrangler tail -c
wrangler.selfhost.json`. If a run stops part way, run it again: the
Worker's name and account, and then the App it created, are kept in
`.selfhost-app.json` (mode 0600, gitignored, and deleted once setup
finishes), so it carries on with the same Worker and without making
another App. It won't deploy over a Worker that already exists on your
account unless that file says selfhost made it and the Worker's
deployment history still has the version selfhost recorded, and later
runs refuse a different `--name`. `--update` checks the same against
`.selfhost-worker.json` (gitignored), which records the Worker once
setup has finished.

Cloudflare shows only a Worker's last ten deployments, and changing a
secret or rolling back counts as one. After ten or more made outside
selfhost, the recorded version drops out of that history and selfhost
refuses to touch the Worker. Running `npm run selfhost -- --update`
after changing the Worker by hand keeps the record current and avoids
this. If it happens anyway, `npm run selfhost -- --trust-worker` shows
the Worker's deployments and, once you type its name back, records the
newest as selfhost's own. It only works at a terminal, so no script can
answer for you. If GitHub creates the App but the next step fails,
the App's key can't be fetched again: delete the App (it says where)
and run it again.

## Confirm hibernation on Cloudflare

1. Sign in and deploy (the free plan is enough):

   ```
   npx wrangler login
   npx wrangler secret put TICKET_KEY
   npx wrangler secret put API_KEY_SECRET
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
