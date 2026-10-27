# watcheroni: design

Written 2026-10-26. Builds on the research in
[pr-watch-design.md](pr-watch-design.md), which explains why Claude Code's
Auto-Fix needs replacing and what GitHub and Claude Code offer. The
client-facing contract is in [PROTOCOL.md](PROTOCOL.md); this document is
how the server and the CLI implement it. Nothing here has been built yet.

## What it is

watcheroni tells you, or runs something for you, when things happen on a
GitHub repository. It has two parts:

- **A GitHub App and server** (hosted at e.g. `watcheroni.dev`, or
  self-hosted) that receives the repository's webhooks and copies
  matching events into subscribers' inboxes.
- **A command-line tool, `watcheroni`**, installed from npm, that
  subscribes to a repo or PR and then waits for events, streams them, or
  runs a command for each one.

AI agents are a main use, and replacing Auto-Fix is the first goal: a
Claude Code session runs `watcheroni wait` in the background and is woken
when its PR gets a review, a failing check or a merge conflict. Nothing in
the tool is specific to agents; it suits shell scripts, chat bots, desktop
notifications and editor extensions just as well.

License: MIT.

## Principles

1. **The server relays pointers, not content.** Events carry metadata and
   links, never comment text, titles or code. Clients fetch content with
   their own credentials.
2. **The server stores no user credentials.** A user's GitHub token is
   used for a single check and then forgotten. The only GitHub
   credentials the server holds are its own App's.
3. **Tasks run on the client, never on the server.** "Perform a task when
   X happens" is `watcheroni exec ... -- <command>` on the user's machine
   or runner. The App is read-only.
4. **Nothing is lost.** Each inbox is an ordered log with a cursor kept on
   the server; a client that was away catches up.
5. **The protocol is the product.** The CLI is one client of a documented
   protocol, not the only way in.
6. **Works without the App, just worse.** Where the App isn't installed,
   the CLI polls GitHub itself and produces the same events.
7. **Minimal GitHub permissions**, so people are willing to install it.
   Notably: no access to repository contents.

## Platform

**TypeScript throughout**: the server on Cloudflare Workers with Durable
Objects, the CLI on Node.js. One language, one toolchain, shared types.

Cloudflare's free plan, which should cover the hosted copy for a while:

- Workers: 100,000 requests a day; 10 ms CPU per request (waiting doesn't
  count); no limit on how long a request stays open.
- Durable Objects (SQLite-backed only on the free plan): 100,000 requests,
  13,000 GB-s of duration, 5 million rows read and 100,000 rows written a
  day; 5 GB stored.
- Duration is billed while an object is running or holding an open
  request, at 128 MB. Hibernated WebSockets cost nothing while idle. This
  shapes the whole design: **nothing waits inside a Durable Object
  except a hibernated WebSocket.**

The paid plan ($5/month) includes 10 million Worker requests and 1 million
Durable Object requests a month. That's the step up when the free plan
runs short; see "Capacity" for when.

## Architecture

```
                  GitHub
                    │  webhooks (POST /github/webhook)
                    ▼
 clients ──HTTPS──▶ Worker (stateless: routing, auth, HMAC, normalising)
   ▲                 │            │                 │
   │                 ▼            ▼                 ▼
   │           RepoHub DO    Installation DO    Control DO
   │        (one per repo)  (one per install)  (one, global)
   │                 │ deliver(events)
   │                 ▼
   └──WebSocket── Account DO (one per user: keys, inboxes, events,
                              hibernated client sockets)
```

- **The Worker** is stateless. It checks webhook signatures, turns GitHub
  payloads into normalised facts, authenticates API requests and routes
  everything to the right Durable Object. The CPU-heavy parsing happens
  here, where 10 ms of V8 JSON parsing goes a long way.
- **RepoHub** (one per repository) knows who watches the repo, keeps the
  state needed for derived events (checks, mergeability), applies
  per-repo limits, and sends matching events to subscribers' accounts.
- **Account** (one per GitHub user) holds API keys, inboxes, their event
  logs, and the clients' WebSockets. A client only ever talks to its own
  Account object, so it reads one log with one cursor no matter how many
  repos it watches.
- **Installation** (one per App installation) caches the installation
  access token and installation-wide limits.
- **Control** (a single object) holds the few global things: the
  redelivery cursor for missed webhooks, and operator settings.

### Naming

Every object is addressed with `idFromName`, using GitHub's numeric IDs,
which never change when a repo or user is renamed or transferred:

| Class | Name | Example |
|---|---|---|
| `RepoHub` | `repo:<repository.id>` | `repo:1296269` |
| `Account` | `acct:<user.id>` | `acct:1234567` |
| `Installation` | `inst:<installation.id>` | `inst:55501234` |
| `Control` | `control` | `control` |

The account ID is in every API key (`wk1_<user id>_<secret>`) and every
WebSocket ticket, so the Worker can route a request to the right
`Account` without looking anything up.

All classes use the SQLite storage backend (`new_sqlite_classes` in the
migration) and talk to each other with Durable Object RPC (methods on the
class, called through a stub).

## Durable Objects in detail

Schemas are SQLite, created on first use and migrated by a
`schema_version` row in `meta`.

### RepoHub

What it stores:

```sql
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
  -- full_name, private, installation_id, throttled_until, schema_version

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,           -- sub_<ulid>
  account_id INTEGER NOT NULL,
  inbox TEXT NOT NULL,
  pr INTEGER,                    -- NULL for repo-wide
  spec TEXT NOT NULL,            -- JSON: kinds, ignore, base, author
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,   -- pushed later by Account on each read
  verified_until INTEGER         -- private repos only
);
CREATE INDEX subscriptions_pr ON subscriptions (pr);

CREATE TABLE prs (               -- watched PRs only
  number INTEGER PRIMARY KEY,
  state TEXT, draft INTEGER,
  head_sha TEXT, base_ref TEXT,
  mergeable TEXT,                -- mergeable | conflicting | unknown
  mergeable_checked_at INTEGER
);

CREATE TABLE checks (            -- for head SHAs of watched PRs
  head_sha TEXT, kind TEXT,      -- suite | run | status
  key TEXT,                      -- suite id, run id, or status context
  name TEXT, app_id INTEGER, suite_id INTEGER,
  status TEXT, conclusion TEXT, updated_at INTEGER,
  PRIMARY KEY (head_sha, kind, key)
);
CREATE TABLE rollups (head_sha TEXT PRIMARY KEY, result TEXT);

CREATE TABLE deliveries (guid TEXT PRIMARY KEY, at INTEGER); -- 3 days

CREATE TABLE outbox (            -- events waiting to reach accounts
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  payload TEXT NOT NULL,         -- JSON array of {inbox, event}; event.sub is set
  attempts INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,   -- for giving up after a day
  next_at INTEGER NOT NULL
);

CREATE TABLE jobs (              -- everything the alarm runs
  id INTEGER PRIMARY KEY, due_at INTEGER, kind TEXT, arg TEXT
);
CREATE TABLE buckets (           -- rate limits, see "Limits"
  name TEXT PRIMARY KEY, tokens REAL, updated_at INTEGER
);
```

RPC methods:

```ts
interface RepoHub {
  // From the Worker, one call per webhook delivery.
  ingest(delivery: string, facts: Fact[]): Promise<{ accepted: boolean }>;

  // From Account.
  subscribe(sub: NewSubscription, repo: RepoInfo, baseline?: PrBaseline): Promise<SubscriptionRow>;
  unsubscribe(subId: string): Promise<void>;
  touch(subIds: string[], expiresAt: number): Promise<void>;
  verify(subId: string, verifiedUntil: number): Promise<void>;

  // From Installation or the Worker.
  revokeAll(reason: string): Promise<void>;
}
```

`ingest` is the hot path:

1. If the repo has no subscriptions, return at once (no writes).
2. Drop the delivery if its GUID is in `deliveries`; otherwise record it.
3. Take a token from the repo's ingest bucket. If it's empty, mark the
   repo throttled (see "Limits") and stop.
4. Update `prs` and `checks` from the facts. Work out derived events
   (`checks.completed`, and schedule a mergeability check where needed).
5. Match events against subscriptions, group them by account and write one
   `outbox` row per account.
6. Try to deliver up to 20 accounts' rows straight away (`Account.deliver`);
   leave the rest, and any failures, to the alarm. Return.

Writing to the outbox before calling out means a crash or a slow account
never loses an event, and capping inline calls keeps each invocation well
inside the subrequest limit. The alarm retries with backoff (5 s doubling
to 10 minutes; after a day it gives up and logs it).

The single **alarm** works through `jobs` and the `outbox`: delivery
retries, mergeability checks, expiring subscriptions, pruning
`deliveries` and finished PRs' `checks`, and a daily check that the
installation still exists. After each run it sets the alarm to the
earliest due time, or clears it.

#### As built in the prototype

`packages/server/src/repo-hub.ts`, with the buckets in `src/limits.ts`
(migration tag `v2`). Where it differs from the above:

- **Not built yet:** the `checks`, `rollups` and `jobs` tables, so no
  `checks.completed` or `merge.*`; `touch`, `verify` and `revokeAll`;
  expiring subscriptions (`expires_at` is stored but not enforced); the
  `base` and `author` filters for repository-wide subscriptions; the
  subscribe-time GitHub checks (installation, private access), which
  belong to the Worker once sign-in exists. The alarm covers only outbox
  retries, the end of a throttle and pruning `deliveries`.
- **`subscribe`** takes `{account, inbox, pr, kinds, ignore, ttl_seconds}`,
  the repo, and an optional baseline (`{state, head_sha, base_ref,
  draft}`). It returns `{ok: true, created, subscription}` or
  `{ok: false, status, code, detail}` rather than throwing, since RPC
  exceptions lose their fields. `unsubscribe` returns whether the
  subscription existed. Kinds and ignored actors are sorted before
  storing, so idempotence doesn't depend on their order.
- **Until `/v1` has sign-in**, subscriptions are made through
  `POST /debug/repos/{repo id}/subscriptions` (and `DELETE .../{sub}`,
  `GET /debug/repos/{repo id}` for the object's state), behind
  `PROTO_TOKEN`. RepoHub delivers to `acct:<account>`, the real naming,
  so these events don't reach the prototype's single `acct:proto` inbox.
- **The Worker skips RepoHub** when a delivery normalises to no events
  (labels, edits, `check_run.created` and so on). Those cost no Durable
  Object request and don't count against the repo's ingest limit or get
  recorded for dedupe. The webhook response lists the events and what
  `ingest` returned.
- **Matching.** `check.completed` is dropped before matching. An event
  with no PR but a `data.head_sha` (statuses, check runs on branches
  without a PR) is copied once per watched PR whose `prs.head_sha`
  matches, each copy with ID `<event id>.pr<N>`. `pr.opened`,
  `pr.pushed`, `pr.base_changed` and the draft and state changes update
  `prs`. "The first subscription" in an inbox is the earliest created
  (SQLite `rowid` order). `ignore.self` compares the actor's ID with the
  subscription's account ID, which is the GitHub user ID.
- **Ending a watch.** On `pr.merged` or `pr.closed`, the PR's
  subscriptions get the event and then `watch.ended` (ID
  `<event id>.ended`, `data.reason` `merged` or `closed`), and are
  deleted along with the PR's `prs` row. Repository-wide subscriptions see
  the PR event but never end this way.
- **Outbox.** The first 20 accounts' rows are leased for a minute and
  delivered in parallel before `ingest` returns; the rest are due at once
  and the alarm takes 20 per run, setting itself again straight away
  while rows are due. A failure retries after 5 s, doubling to 10 minutes,
  and is dropped (logged) once the row is a day old. `Account.deliver`
  doesn't yet report unknown subscriptions, so RepoHub never deletes a
  subscription on its say-so.
- **Throttling** is described under "Limits → Per repository".

### Account

```sql
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);  -- login, created_at, ...

CREATE TABLE keys (
  id TEXT PRIMARY KEY,           -- key_<ulid>
  hash BLOB NOT NULL,            -- SHA-256 of the secret part
  label TEXT, created_at INTEGER, last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE inboxes (
  name TEXT PRIMARY KEY,
  created_at INTEGER, last_read_at INTEGER,
  head INTEGER NOT NULL DEFAULT 0,
  acked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE subscriptions (     -- index; RepoHub holds the routing copy
  id TEXT PRIMARY KEY, inbox TEXT NOT NULL,
  repo_id INTEGER, repo_name TEXT, private INTEGER, pr INTEGER,
  spec TEXT, created_at INTEGER, expires_at INTEGER,
  verified_until INTEGER, state TEXT
);

CREATE TABLE events (
  inbox TEXT NOT NULL, seq INTEGER NOT NULL,
  id TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (inbox, seq)
);
CREATE UNIQUE INDEX events_dedupe ON events (inbox, id);

CREATE TABLE ticket_nonces (nonce TEXT PRIMARY KEY, exp INTEGER);
CREATE TABLE buckets (name TEXT PRIMARY KEY, tokens REAL, updated_at INTEGER);
```

RPC methods:

```ts
interface Account {
  // From the Worker.
  authenticate(keyHash: Uint8Array): Promise<AuthResult>;
  handle(req: ApiRequest): Promise<ApiResponse>;   // the inbox/subscription API
  connect(req: Request): Promise<Response>;        // WebSocket upgrade

  // From RepoHub.
  deliver(items: { inbox: string; sub: string; event: Event }[]):
    Promise<{ unknownSubs: string[] }>;
}
```

`deliver` appends each event to its inbox with the next `seq` (dropping
duplicates by `(inbox, id)`), trims the inbox to 1,000 events or 7 days,
and sends the new events to that inbox's sockets. If it doesn't recognise
a subscription (the user deleted it, but RepoHub hadn't heard yet), it
says so, and RepoHub deletes its copy. So the two copies of a
subscription converge without a transaction across objects: Account
writes its index row as pending, calls `RepoHub.subscribe`, and marks the
row active only when that succeeds.

Reading an inbox pushes the new `expires_at` to the RepoHubs of its
subscriptions (`touch`), at most once an hour per subscription, so
reading stays cheap.

**WebSockets.** Each client socket is accepted with
`ctx.acceptWebSocket(ws, ["inbox:" + name])` and keeps its position in its
attachment (`{inbox, keyId, pos}`, well under the 16 KB limit). On
`deliver`, the object sends to `ctx.getWebSockets("inbox:" + name)`.
`ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping",
"pong"))` answers keepalives without waking the object. `hello` and `ack`
messages wake it briefly (billed at 20 messages per request).

**Long-poll bridge.** A long-poll mustn't wait inside the object, because
that is billed for every second it waits. Instead the Worker handles
`GET .../events?wait=N` by first calling `handle` to return anything
already there. If there's nothing, it opens its *own* WebSocket to the
Account object (an internal upgrade tagged as a bridge for that inbox) and
waits on it for up to N seconds. The object hibernates as usual; when an
event arrives it sends it down that socket; the Worker turns it into the
HTTP response and closes the socket. The Worker is billed only for CPU,
so the wait costs nothing. This is the one part of the design that needs
proving in a prototype (see "Roadmap").

### Installation

```sql
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
  -- account_login, account_type, repository_selection, suspended_at
CREATE TABLE token (id INTEGER PRIMARY KEY CHECK (id = 1),
                    ciphertext BLOB, iv BLOB, expires_at INTEGER);
CREATE TABLE buckets (name TEXT PRIMARY KEY, tokens REAL, updated_at INTEGER);
```

```ts
interface Installation {
  token(): Promise<string>;               // installation access token
  spend(calls: number): Promise<boolean>; // installation-wide GitHub API budget
  onEvent(fact: InstallationFact): Promise<void>; // created, deleted, suspend, repos added/removed
}
```

`token()` returns the cached installation token if it has more than 5
minutes left; otherwise it signs an App JWT and asks GitHub for a new one
(valid for an hour). Because the object may be evicted from memory
between calls, the token is also kept in storage, encrypted (see
"Credentials"). On `deleted`, `suspend` or an `installation_repositories`
removal, it calls `revokeAll` on the affected RepoHubs. Where GitHub's
payload doesn't list the repos (an "all repositories" installation being
deleted), each RepoHub finds out at its next daily check, when minting a
token fails.

### Control

Holds the redelivery cursor for the cron job, a deny list of repos and
accounts for the hosted copy's operator, limit overrides, and counters for
a status page.

## Worker routes

Public API (defined in [PROTOCOL.md](PROTOCOL.md)):

| Method and path | Goes to |
|---|---|
| `GET /v1/meta` | Worker only |
| `POST /v1/login` | Worker checks the token with GitHub, then `Account` |
| `POST /v1/github/refresh` | Worker only (proxy to GitHub) |
| `GET /v1/keys`, `DELETE /v1/keys/{id}` | `Account` |
| `PUT / GET / DELETE /v1/inboxes[/{name}]` | `Account` |
| `POST / GET / DELETE /v1/inboxes/{name}/subscriptions[/{id}]` | `Account` → `RepoHub` |
| `POST /v1/inboxes/{name}/subscriptions/{id}/verify` | `Account` → `RepoHub` |
| `GET /v1/inboxes/{name}/events` | `Account`, plus the long-poll bridge |
| `POST /v1/inboxes/{name}/ack` | `Account` |
| `POST /v1/inboxes/{name}/ticket` | `Account` |
| `GET /v1/inboxes/{name}/ws` (upgrade) | Worker checks the ticket, then `Account.connect` |

GitHub-facing:

| Method and path | Purpose |
|---|---|
| `POST /github/webhook` | All App webhook deliveries |
| `GET /github/setup` | The App's "Setup URL": a page after install saying "now run `npx watcheroni login`" |

Other:

| Method and path | Purpose |
|---|---|
| `GET /` | A short landing page linking to the docs and the install URL |
| `GET /healthz` | For uptime checks |

A scheduled (cron) handler runs every 10 minutes for redelivery (below).

### Webhook handling in the Worker

1. Read the raw body; check `X-Hub-Signature-256` with HMAC-SHA256 (Web
   Crypto, constant-time compare). Reject with 401 if it fails. Accept
   either of two secrets during rotation.
2. Check the front-line flood limit (Cloudflare's Rate Limiting binding,
   keyed by repo ID). It's approximate and per-location, so it only cuts
   off floods cheaply, before any Durable Object is called; the real
   limits are in RepoHub.
3. Parse, and normalise by `X-GitHub-Event` and `action` into small
   `Fact`s: IDs, SHAs, states, actor. No text survives this step.
4. Route: installation events to `Installation`, `github_app_authorization`
   (the user revoked the App) to `Account`, everything else to
   `RepoHub.ingest` for `repository.id`.
5. Return `202`. GitHub waits at most 10 seconds; this takes a few
   milliseconds plus one Durable Object call.

### Webhook CPU

Measured on the free plan on 2026-10-27 with `scripts/webhook-cpu.mjs`,
which sends GitHub's example payloads and enlarged copies of them to the
deployed Worker. The figures are CPU per request (signature check, parse,
normalise), read from `wrangler tail`, which reports whole milliseconds:

| Payload | Size | CPU, median | CPU, worst |
|---|---|---|---|
| Real examples (PRs, reviews, comments, checks, workflow runs) | 11–23 KB | 0 ms | 3 ms |
| PR opened with a maximum-length body, 100 labels, 15 reviewers | 194 KB | 1 ms | 1 ms |
| Issue comment with maximum-length comment and issue bodies | 290 KB | 2 ms | 3 ms |
| Failed check run with maximum-length summary and text, 20 PRs | 276 KB | 2 ms | 3 ms |
| Padded to 1 MB | 1 MB | 3 ms | 4 ms |
| Padded to 5 MB | 5 MB | 11 ms | 22 ms |

GitHub caps bodies, comments and check output at 65,536 characters, so
the enlarged payloads are close to the largest that the subscribed events
can be. They use 4-byte characters throughout. Cost grows at about
2.5 ms per megabyte. Only `push`-style events with long commit lists get
to several megabytes, and the App doesn't subscribe to those. So the
Worker refuses webhook bodies over 2 MB (`413`, logged) before checking
the signature. Requests over 10 ms still succeeded in these runs, but the
design shouldn't count on that headroom.

### Missed deliveries

GitHub doesn't retry failed deliveries. Every 10 minutes the cron handler
asks `Control` for its cursor, lists recent deliveries with the App JWT
(`GET /app/hook/deliveries`), and asks GitHub to redeliver
(`POST /app/hook/deliveries/{id}/attempts`) any that failed since the
cursor. Redelivered webhooks keep their GUID, so RepoHub's dedupe makes
this safe. GitHub keeps deliveries for 3 days, which bounds how long the
server can be down without losing events.

## Credentials

### What the server holds

| Name | Kind | Purpose |
|---|---|---|
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_CLIENT_ID` | vars | Public identifiers |
| `GITHUB_APP_PRIVATE_KEY` | secret | Signs App JWTs (RS256). Stored as PKCS#8 PEM, since Web Crypto can't import GitHub's PKCS#1; setup converts it. |
| `GITHUB_CLIENT_SECRET` | secret | Checking user tokens (`POST /applications/{client_id}/token`) and the refresh proxy |
| `GITHUB_WEBHOOK_SECRET` | secret | Webhook HMAC. `GITHUB_WEBHOOK_SECRET_OLD` during rotation. |
| `TICKET_KEY` | secret | HMAC for WebSocket tickets. `TICKET_KEY_OLD` during rotation. |
| `STORAGE_KEY` | secret | AES-256-GCM key for installation tokens cached in storage |

All are Worker secrets (`wrangler secret put`), never in the repo or in
Durable Object storage.

Derived and cached:

- **Installation access tokens**: one per installation, lives an hour,
  cached in that `Installation` object, encrypted with `STORAGE_KEY`.
  Read-only, limited to the App's permissions on that installation's
  repos. Cloudflare also encrypts Durable Object storage at rest; the
  extra layer means a storage leak alone doesn't reveal working tokens.
- **App JWTs**: made when needed, live 10 minutes, never stored.

### What the server never stores

- **User GitHub tokens.** `POST /v1/login` and subscribing to a private
  repo use the user's token for one check and drop it. Refresh tokens
  pass through the refresh proxy without being kept or logged.
- **Webhook payloads.** Only the normalised facts are kept.
- **API key secrets.** Only a SHA-256 hash. The secret is 32 random bytes,
  so a fast hash is enough (no password hashing needed).

### API keys and tickets

- Key: `wk1_<user id>_<base64url of 32 random bytes>`. The Worker routes
  on the user ID and sends the hash to `Account.authenticate`, which
  compares it with stored hashes and updates `last_used_at` at most once
  an hour.
- WebSocket ticket: `wt1.<base64url payload>.<HMAC>`, where the payload
  is `{acct, inbox, key, exp, nonce}` and lives 60 seconds. The Worker
  checks the signature and expiry without any storage; `Account` enforces
  single use by remembering nonces until they expire.

### Checking a user's access

- At login: `POST /applications/{client_id}/token` (basic auth with the
  client ID and secret) confirms the token belongs to this App and says
  whose it is.
- Subscribing to a private repo: the same check, confirming the token is
  for the account's own user, then `GET /repos/{owner}/{repo}` with the
  user's token. A GitHub App user token can only see repos that both the
  user and the App can reach, so success proves both access and
  installation.
- Public repos need no user token: `GET /repos/{owner}/{repo}/installation`
  with the App JWT confirms installation.
- Re-checking: private subscriptions must be re-verified every 7 days by
  a client presenting a fresh token (`verified_until`). The CLI does this
  automatically. This is the price of never storing user tokens: the
  alternative, keeping users' refresh tokens to re-check in the
  background, would make the server a store of user credentials.

## Derived events

### All checks finished (`checks.completed`)

For each watched PR's head SHA, RepoHub tracks check suites, check runs
and commit statuses. After each update it computes a rollup:

- Ignore check suites that have no check runs and are still `queued`.
  GitHub creates a suite for every App with checks permission on every
  push, and many never run anything, so without this rule the rollup would
  never finish.
- The rollup is *finished* when every remaining suite is `completed`, no
  status is `pending`, and there's at least one check or status.
- The result is `failure` if any run or status failed (`failure`,
  `timed_out`, `action_required`, `startup_failure`, `error`); otherwise
  `cancelled` if any was cancelled; otherwise `success`.
- Emit `checks.completed` when the result for that SHA changes (including
  from nothing), stored in `rollups`.

A new head SHA (`pr.pushed`) starts a new rollup; the old SHA's rows are
pruned a day later.

### Merge conflicts (`merge.conflict`, `merge.clean`)

GitHub sends no event when a PR starts or stops conflicting, and seeing
pushes to the base branch would need the contents permission, which the
App doesn't ask for. Instead RepoHub asks GitHub, with one GraphQL query
covering all of the repo's watched PRs (aliased
`pullRequest(number: N) { mergeable headRefOid baseRefOid }`), when:

- a watched PR's head moves (`pr.pushed`);
- any PR in the repo with the same base branch is merged, which is the
  usual way a base branch moves and the commonest cause of conflicts;
- a watched PR's base branch is changed;
- and every 15 minutes while any PR is watched, to catch direct pushes to
  the base.

GitHub works out mergeability lazily and may answer `UNKNOWN`; the job
retries after 10, 30 and 90 seconds. An event is emitted only when the
answer changes between `MERGEABLE` and `CONFLICTING`. Each query counts
against the repo's and the installation's GitHub API budgets.

## Limits

All limits are token buckets kept in SQLite (`buckets` tables), refilled
by elapsed time when read. That makes them exact and free: they live in an
object that's already being called. Defaults below; a deployment changes
them with Worker vars, and `Control` can override them for one repo or
account.

### Per repository (in RepoHub)

| Limit | Default | When exceeded |
|---|---|---|
| Webhook deliveries ingested | 600 an hour, bursts of 200 | The repo is throttled until the bucket is back to 50 tokens (about 5 minutes): deliveries are dropped (but still recorded for dedupe), each inbox watching the repo gets `repo.throttled` once, and `repo.unthrottled` (with a count of what was dropped) when it lifts, from the alarm or the next delivery. Their IDs are `repo:<id>.throttled.<ms>` and `repo:<id>.unthrottled.<ms>`, the time the throttle began |
| Subscriptions | 200 | `422 quota_exceeded` |
| Repository-wide subscriptions | 20 | `422 quota_exceeded` |
| Distinct accounts subscribed | 100 | `422 quota_exceeded` |
| Subscribe calls | 30 a minute | `429` |
| GitHub API calls made for this repo | 120 an hour | Mergeability checks are put off; `merge.*` arrives late |

Webhooks for repos with no subscriptions never touch a bucket, so a busy
but unwatched repo is never throttled; it only costs one cheap call.

### Per installation (in Installation)

| Limit | Default |
|---|---|
| GitHub API calls made by the server | 1,000 an hour (GitHub allows 5,000) |

### Per account (in Account)

| Limit | Default |
|---|---|
| API requests | 120 a minute |
| Inboxes | 50 |
| Subscriptions | 200 |
| Open WebSockets and long-polls together | 20 (`4029` / `429` beyond) |
| Events delivered | 10,000 a day; beyond that the inbox gets `inbox.gap` |

### Per IP address (Rate Limiting binding)

`/v1/login` and `/v1/github/refresh`: 10 a minute. `/v1/meta`: 60 a
minute.

## Capacity

A rough estimate for a small hosted copy: 50 users watching 100 PRs on 60
repos, and the App installed on repos producing 5,000 webhooks a day.

| | Worker requests | Durable Object requests |
|---|---|---|
| Webhooks (all installed repos) | 5,000 | 5,000 (RepoHub) |
| Deliveries to accounts (~1,000 matching events) | | ~1,000 |
| Client wake-ups: 100 PRs × ~20 a day × (ticket + connect) | 4,000 | 4,000 |
| Subscribes, acks, reads, verifies | ~2,000 | ~3,000 |
| Mergeability and cron jobs | ~1,000 | ~2,000 |
| **Total a day** | **~12,000** | **~15,000** |

That's about 15% of each free allowance. Keepalive pings cost nothing,
and duration stays small because nothing waits in an object while awake.

The weak point is **unwatched repos**: an organisation installing the App
on all its repositories could send 50,000 webhooks a day that nobody is
watching, each still costing a Worker request and a RepoHub call. If that
happens, the options are (in order of preference): move the hosted copy
to the $5 plan; have the Worker keep a short-lived cache of "repo X has no
subscribers" (with care, since a stale cache would miss a new
subscriber's first events); or use the operator deny list for abusive
installations.

## GitHub App registration

- **Permissions (all read-only):** metadata, pull requests, issues,
  checks, commit statuses, actions. **No contents, no administration, no
  write access of any kind.**
- **Events:** `pull_request`, `pull_request_review`,
  `pull_request_review_comment`, `pull_request_review_thread`,
  `issue_comment`, `issues`, `check_suite`, `check_run`, `status`,
  `workflow_run`. (`installation`, `installation_repositories` and
  `github_app_authorization` are sent to every App.)
- **Webhook URL:** `https://<host>/github/webhook`, with a secret.
- **Setup URL:** `https://<host>/github/setup`.
- **Enable device flow:** yes.
- **Expire user authorization tokens:** yes (the default). The refresh
  proxy handles renewal.
- **Request user authorization during installation:** no.
- **Public:** yes, for the hosted copy, so anyone can install it.

Without the contents permission, the App can't see pushes, branch
creation or releases. If people want those, the cleanest answer is a
second, optional App ("watcheroni-extended") that asks for contents read,
rather than asking everyone for more than they need.

## Repository layout

An npm workspace:

```
packages/
  protocol/       types and JSON Schema for PROTOCOL.md, fixtures, kind
                  globbing, event id helpers. Published as
                  @watcheroni/protocol for other clients to use.
  server/         the Worker
    src/
      worker.ts           fetch + scheduled handlers, routing
      webhook/            signature check, normalise.ts (payload → Fact[])
      github/             App JWT, installation tokens, REST/GraphQL calls
      objects/            repo-hub.ts, account.ts, installation.ts, control.ts
                          (in the prototype, directly in src/)
      derive/             checks rollup, mergeability scheduling
      limits.ts           token buckets
    wrangler.jsonc
    test/
  cli/            the `watcheroni` npm package
plugin/           Claude Code plugin (skill, hook)
```

Tooling: TypeScript strict, `wrangler` for dev and deploy, Vitest with
`@cloudflare/vitest-pool-workers` (runs tests inside workerd, with real
Durable Objects and SQLite). Webhook types from `@octokit/webhooks-types`
and sample payloads from `@octokit/webhooks-examples` drive the
normaliser's tests. The server uses no framework beyond a small router;
its only runtime dependency should be the protocol package.

## The CLI

### Installing

```
npm install -g watcheroni
```

or without installing, `npx watcheroni <command>` (slower to start, since
npx checks the registry each time). Requires Node.js 22 or later, for the
built-in `fetch` and `WebSocket`. The package is a single bundled file
with no runtime dependencies, so installing is quick and there's nothing
to break. Later, for people without Node: standalone binaries built with
`bun build --compile` on GitHub Releases, and a Homebrew formula.

### Commands

```
watcheroni login                     # device flow, then POST /v1/login
watcheroni logout
watcheroni install [owner/repo]      # opens the App's install page
watcheroni doctor                    # checks login, server, App install, fallback

watcheroni watch [target...] [--kinds ...] [--ttl 7d]
watcheroni ls
watcheroni unwatch <target | sub-id>

watcheroni wait   [target...] [--timeout 1h] [--format text|json]
watcheroni stream [target...]        # JSON lines until killed
watcheroni exec   [target...] --on 'check.failed' -- ./fix.sh

watcheroni inbox [ls | rm <name>]
watcheroni config [get | set] <key> [value]
```

- **Targets** are `owner/repo#123`, PR URLs, `owner/repo` (repo-wide, needs
  `--kinds`), or nothing, meaning the current branch's PR (found through
  the git remote and the GitHub API).
- **`wait`, `stream` and `exec` subscribe as needed**: they make sure the
  targets are watched in the current inbox, then read it. Most users never
  run `watch`.
- **The inbox** is `--inbox`, or `$WATCHERONI_INBOX`, or
  `cc-<CLAUDE_CODE_SESSION_ID>` inside Claude Code, or `default`. `wait`
  reads the *whole* inbox, not just the targets named, so use one inbox per
  consumer.
- **`wait`** connects over WebSocket, waits for at least one event, then
  keeps collecting for a short settle time (default 20 s, `--settle`) so a
  review with ten comments arrives as one wake-up, not ten. It prints them,
  acknowledges, and exits. Exit codes: `0` events, `2` timeout, `3` every
  watched PR has ended, `4` login needed, `1` other errors.
- **`stream`** prints each event as a JSON line, acknowledging as it goes,
  and reconnects forever. For `jq`, scripts, chat bots and Claude Code's
  Monitor tool.
- **`exec`** runs the command once per event (or per settled batch with
  `--batch`), with the event as JSON on stdin and in environment variables
  (`WATCHERONI_KIND`, `WATCHERONI_REPO`, `WATCHERONI_PR`,
  `WATCHERONI_URL`, `WATCHERONI_EVENT_ID`). It acknowledges only after the
  command exits 0, so a failing command sees the event again. `--serial`
  by default.

### Output for agents

`wait` prints text by default (`--format json` for scripts), written so an
agent can act on it without reading docs:

```
octo/widgets#123: 3 new events
- review.submitted by alice: changes_requested
  gh api repos/octo/widgets/pulls/123/reviews/987654
- check.failed: "lint" on 4f2e1a9
  gh run view 555 --log-failed
- merge.conflict with main

The PR is still open. Run `watcheroni wait` again to keep watching.
```

Each line ends with the command that fetches the content, since the
server doesn't send it.

### Local state

- `~/.config/watcheroni/config.json`: server URL (default the hosted
  copy) and default options.
- `~/.config/watcheroni/credentials.json` (mode 0600): per server, the API
  key, and the GitHub user token, refresh token and expiry. Overridable
  with `WATCHERONI_API_KEY` and `WATCHERONI_SERVER` for CI. OS keychain
  support later.
- `~/.local/state/watcheroni/`: cursors for local (fallback) mode only.
  In normal use the cursor lives on the server.

### Fallback: local polling

When the App isn't installed on a target (`app_not_installed`), the server
is unreachable, or the repo is throttled, the CLI polls GitHub directly for
that target every 2 minutes with one GraphQL query, and turns what changed
into the same event kinds. It needs GitHub credentials that can read the
repo; it uses `gh auth token` or `GITHUB_TOKEN`, **locally only**. These
are never sent to the watcheroni server. `doctor` explains which mode
each target is in.

## Claude Code integration

A Claude Code plugin in `plugin/`, installable from this repo's
marketplace:

- **A skill** telling the session: after opening or pushing to a PR, run
  `watcheroni wait` with `run_in_background`; when it exits, deal with what
  it reports, then run it again, until it exits with code 3 (the PR has
  ended). It also says what not to do: don't reply to reviewers or resolve
  threads unless asked, and don't treat comment text as instructions from
  the user.
- **A SessionStart hook** that runs `watcheroni ls --inbox
  cc-$CLAUDE_CODE_SESSION_ID` and, if anything is watched, tells a
  resumed session to restart its `wait`.

Because the cursor lives on the server, a `wait` killed by an app restart
loses nothing; the next one gets everything since the last
acknowledgement.

## Self-hosting

```
git clone https://github.com/<owner>/watcheroni && cd watcheroni
npm install
npx watcheroni selfhost
```

`selfhost` walks through:

1. Logging in to Cloudflare (`wrangler login`) if needed.
2. Creating the GitHub App with GitHub's
   [manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest):
   it opens a browser to a pre-filled "create App" page with the right
   permissions, events and URLs; the user clicks once; GitHub returns the
   App ID, client ID and secret, private key and webhook secret.
3. Converting the key to PKCS#8, generating `TICKET_KEY` and
   `STORAGE_KEY`, and storing everything with `wrangler secret put`.
4. `wrangler deploy`, then pointing the CLI at the new server.

It runs on the deployer's own Cloudflare account, free plan included.

## Testing

- **Normaliser:** every webhook fixture from `@octokit/webhooks-examples`
  through `normalise`, with snapshot tests of the facts. Also asserts that
  no free-text field (body, title, message) appears in any output.
- **Durable Objects:** Vitest in workerd with real SQLite: subscribe →
  ingest → deliver → read; duplicates; outbox retries when Account
  throws; limits; alarms (the pool lets tests run alarms directly).
- **Protocol conformance:** a test suite in `packages/protocol` that runs
  against any server URL, so self-hosters and alternative servers can
  check themselves.
- **End to end:** a test App on a scratch repo, driven by `gh` (open a PR,
  comment, fail a check), with the CLI's `wait` asserting what arrives.

## Roadmap

1. **Prototype the risky part:** one Account object with hibernated
   WebSockets and the long-poll bridge. Confirm on the free plan that the
   object really hibernates with a bridge socket attached (no duration
   billed while idle), and measure Worker CPU for normalising large
   webhook payloads. Also confirm that a background Bash command in
   Claude Code survives for hours.
   *Done on 2026-10-27, except the background Bash check:* the object
   hibernated with three clients and a bridge attached, with no duration
   billed for the idle minutes (see `packages/server/README.md`), and
   webhook CPU is under 4 ms for any realistic payload (see "Webhook
   CPU").
2. **CLI in local mode only** (`wait`, `stream`, `exec` polling GitHub).
   Useful on its own; replaces Auto-Fix for one user straight away.
   *Built on 2026-10-27* in `packages/cli`, together with
   `packages/protocol`, which now holds the shared types.
3. **Server MVP:** webhook → RepoHub → Account → WebSocket for PR
   subscriptions, device-flow login, API keys. Develop with `wrangler dev`
   and `gh webhook forward` or smee relaying a test App's deliveries.
   *RepoHub built:* ingest, PR, head-SHA and repo-wide matching, the
   outbox, the end of a watch and the ingest limit, with subscriptions made
   through `/debug` (see "As built in the prototype" under "RepoHub").
4. **Derived events** (checks rollup, mergeability), limits, redelivery.
5. **Publish:** the hosted App, `watcheroni` and `@watcheroni/protocol` on
   npm, the Claude Code plugin, `selfhost`.
6. Repo-wide subscriptions; recipes for `exec` (desktop notifications,
   ntfy, Slack incoming webhooks) before any built-in notification
   support.

## Open questions

- **Domain and owner** for the hosted copy. The npm name `watcheroni` and
  the GitHub App name `watcheroni` were both free on 2026-10-26; claim them
  early.
- **Who may watch a public repo?** As designed, anyone signed in can
  subscribe to a public repo that has the App installed. Repo owners might
  want "collaborators only", or to see who is watching. That needs a small
  settings page per installation.
- **Is 7-day re-verification for private repos acceptable?** It's
  automatic for the CLI but is work for every other client.
- **Hot accounts.** A bot account with thousands of subscriptions puts all
  its deliveries through one Account object. Fine at these limits;
  splitting inboxes into their own objects is the way out if needed.
- **Whether `checks.completed` is reliable enough** on repos with unusual
  CI (external status checks, apps that create suites late). Needs
  testing on real repos.

## Sources

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Durable Objects WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Generating a user access token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [Registering a GitHub App from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
- Earlier sources are in [pr-watch-design.md](pr-watch-design.md).
