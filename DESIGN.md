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

It's a tool, not a workflow: it reports what happened and leaves what to
do about it to whoever runs it. The use that started it is a coding
agent running `watcheroni wait` in the background, to be woken when its
PR gets a review, a failing check or a merge conflict. Nothing in the
tool is specific to agents; it suits shell scripts, chat bots, desktop
notifications and editor extensions just as well, and the Claude Code
plugin is one convenience among those, not the main way in.

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

- **Not built yet:** the `jobs` table (the alarm's one periodic job,
  the mergeability check, is the `merge_check_at` meta row, as pruning is
  `prune_at`).
- **Derived events** (schema 5) are described under "As built" in
  "Derived events".
- **`base` and `author`** (repository-wide only) are kept in `spec`, so
  they count for idempotence; `author` is lowercased. They match against
  `prs`, which gained `author` and `seen_at` columns (schema 4; every
  migration step is idempotent, since "schema 3" meant `prs.author` on
  one branch and ticket 003's check tables on another). While any
  repo-wide subscription has one (a `tracks_all_prs` flag in `meta`, set
  by `subscribe` and recomputed when a repo-wide subscription goes),
  `prs` holds every open PR RepoHub has heard of, not only watched ones,
  up to 1,000; past that, the least recently written PRs that no PR
  subscription needs are forgotten (`seen_at` is set only by writes
  RepoHub makes anyway, not on every event). Rows come from:
  - the repo's open PRs, once: the subscription that sets the flag
    answers `needs_open_prs`, and the Worker then lists the 100 most
    recently updated (one more installation API call) and passes them to
    `rememberOpenPrs`, one upsert that writes new rows whole but only
    fills gaps in rows it already has, since the listing can be older than
    a push, base change or close that arrived meanwhile.
    If the list fails, the subscription stands anyway;
  - `pr.opened`, `pr.reopened`, and an internal `pr.seen` fact, which the
    normaliser emits (`head_sha`, `base`, `author`, `state`) after the
    other events of any payload that describes the PR (`pull_request*`,
    and `issue_comment` on a PR, which gives only the author). `pr.seen`
    writes only to fill a gap, so most PR webhooks cost no row write; the
    head and base move with `pr.pushed` and `pr.base_changed`. It never
    makes a delivery that would otherwise be skipped reach RepoHub.

  Closed and merged PRs are dropped as before, and when the last
  filtering subscription goes, so are rows no PR subscription needs. A
  filtered subscription gets an event only if its PR is known and
  matches, so never issue events or statuses on a commit that's no known
  PR's head. While rows are kept, head-SHA matching (below) also gives
  such statuses those PRs, which unfiltered repo-wide subscriptions see
  too.
- **Expiry is pulled, not pushed.** There's no `touch`: reading an inbox
  only records `last_read_at` in Account (a WebSocket `hello` counts, and
  so does having a socket open). When a subscription reaches
  `expires_at`, RepoHub's alarm asks the Account
  (`subscriptionActivity`) when each due subscription should now expire,
  counting its TTL (`ttl_seconds`, a column since schema 2) from the last
  read, or from now while a client is connected. Only one nobody has read
  for the whole TTL ends, with `watch.expired`. So reads cost RepoHub
  nothing, and an expiry check costs one Account call per account.
- **Verification** is `reverify(subId, until)` from
  `POST .../{id}/verify`, which checks the user's token as subscribing
  does. A token that works but can no longer read the repo ends the
  subscription at once (`endSubscription`, `watch.unverified` with reason
  `access_denied`); one past `verified_until` ends from the alarm (reason
  `not_verified`). The CLI renews private subscriptions due within two
  days, when it starts and every six hours while it runs.
- **The alarm** covers outbox retries, the end of a throttle, the next
  `expires_at` or `verified_until`, mergeability checks, and pruning
  `deliveries` and old `checks` and `rollups`.
- **`subscribe`** takes `{account, inbox, pr, kinds, ignore, ttl_seconds,
  verified_until}`, the repo, and an optional baseline (`{state, head_sha,
  base_ref, draft, mergeable}`); subscribing again with a later
  `verified_until` moves it on. It returns `{ok: true, created, subscription}` or
  `{ok: false, status, code, detail}` rather than throwing, since RPC
  exceptions lose their fields. `unsubscribe` returns whether the
  subscription existed. Kinds and ignored actors are sorted before
  storing, so idempotence doesn't depend on their order.
- **Subscriptions** come from `/v1` (see "As built" under
  "Installation"), or straight from
  `POST /debug/repos/{repo id}/subscriptions` (and `DELETE .../{sub}`,
  `GET /debug/repos/{repo id}` for the object's state) behind
  `DEBUG_TOKEN`, with no GitHub checks and no Account index row. RepoHub
  delivers to `acct:<account>`, the Account object that the account's API
  keys read from.
- **`revokeAll(reason, eventBase)`** sends each subscription a
  `watch.revoked` (ID `<eventBase>.revoked.<sub>`, the webhook's delivery
  ID as the base, `data.reason` `uninstalled`, `suspended` or `removed`)
  through the outbox, and deletes all subscriptions and `prs` rows.
- **The Worker skips RepoHub** when a delivery normalises to no events
  (labels, edits and so on). Those cost no Durable
  Object request and don't count against the repo's ingest limit or get
  recorded for dedupe. The webhook response lists the events and what
  `ingest` returned.
- **Matching.** The normaliser's internal kinds (`check.completed`,
  `check.started`, `check_suite.updated`, `base.advanced`; see "Derived
  events") are used and dropped before matching. An event
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
  createKey(id: string, hash: ArrayBuffer, label: string | null, login: string): KeyInfo;  // at login
  authenticate(keyHash: ArrayBuffer): Promise<AuthResult>;  // live key? takes one request token
  listKeys(): KeyInfo[];
  revokeKey(id: string): boolean;   // also closes that key's sockets with 4001
  revokeAllKeys(): number;          // github_app_authorization "revoked"
  handle(req: ApiRequest): Promise<ApiResponse>;   // the inbox/subscription API
  fetch(req: Request): Promise<Response>;          // WebSocket upgrade

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

`authenticate` returns the key's ID and the account's request budget
(the `RateLimit-*` headers), or why not (`unauthorized`, `rate_limited`
with a retry time), so one call both authenticates and rate-limits.
(The prototype calls separate inbox methods, such as `ensureInbox` and
`readEvents`, instead of one `handle`.)

**WebSockets.** Each client socket is accepted with
`ctx.acceptWebSocket(ws, ["inbox:" + name, "key:" + keyId])` and keeps its
position in its attachment (`{inbox, keyId, pos}`, well under the 16 KB
limit). The Worker passes the key ID, and for a ticket its nonce and
expiry, on the internal upgrade request; the object checks the key is
still live and records the nonce before accepting. Revoking a key closes
the sockets tagged with it. On
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

#### As built in the prototype

`packages/server/src/installation.ts` (migration tag `v3`), with App JWTs
and token minting in `src/app.ts` and the `/v1` subscription endpoints in
`src/subscriptions.ts`. Where it differs from the above:

- **`token(installationId, calls)`** takes `calls` from the API budget
  first and returns `{ok: true, token}` or `{ok: false, reason}`
  (`not_installed`, `rate_limited` with `retry_after`, `unavailable`),
  since RPC exceptions lose their fields. The object can't read its own
  name, so callers pass the ID. A 404 or 403 when minting marks the
  installation deleted or suspended, ahead of its webhook. Without a
  usable `STORAGE_KEY` the token is kept in memory only.
- **Which repos to revoke.** GitHub's `deleted` and `suspend` payloads
  don't always list the repos, so the object keeps its own `repos` table:
  each repo that gets a `/v1` subscription through it (`addRepo`). On
  `deleted` or `suspend` every one of them is revoked; on `removed`, those
  in `repositories_removed`. Revocations wait in a `revocations` table and
  go out 20 RepoHubs per invocation, the rest from the alarm, with retries
  (5 s doubling to 10 minutes, 12 attempts). `created`, `unsuspend` and
  `new_permissions_accepted` clear the deleted or suspended mark. No
  daily check yet.
- **Subscribing** (`POST /v1/inboxes/{name}/subscriptions`) runs in the
  Worker: `GET /repos/{owner}/{repo}/installation` with an App JWT (404 is
  `409 app_not_installed`, for missing repos too); an installation token,
  spending 2 calls; `GET /repos/{owner}/{repo}` with it for the ID and
  visibility; for a private repo the user-token checks under "Checking a
  user's access", with `verified_until` 7 days on; the PR with the
  installation token as the baseline (404 is `not_found`); the account's
  quota (`Account.checkSubscription`: the inbox must exist, at most 200
  subscriptions); `RepoHub.subscribe`; then `Account.saveSubscription`
  and `Installation.addRepo`. Account keeps the index that `GET` and
  `DELETE` read, and drops a row when a `watch.*` event for it is
  delivered, so it follows RepoHub ending watches.
- The install URL (in `/v1/meta`, `app_not_installed` and the landing
  page) comes from the `GITHUB_APP_SLUG` var, through `installUrl(env)`
  in `src/subscriptions.ts`; a self-hosted copy has its own App.
  `GET /debug/installations/{id}` shows the object's state.

### Control

Holds the redelivery cursor for the cron job, a deny list of repos and
accounts for the hosted copy's operator, limit overrides, and counters for
a status page.

In the prototype (`packages/server/src/control.ts`, migration tag `v4`)
it holds only the redelivery state; see "As built" under "Missed
deliveries".

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

Development only, and answering `404` unless the `DEBUG_TOKEN` secret is
set and sent as `Authorization: Bearer`:

| Method and path | Purpose |
|---|---|
| `POST /debug/accounts/{id}/keys` | Mint an API key without GitHub (account `0` is never a real user) |
| `GET /debug/accounts/{id}/stats` | What the `Account` object is doing (wakes, sockets, inboxes) |
| `POST /debug/accounts/{id}/inboxes/{name}/events` | Inject synthetic events, standing in for RepoHub |
| `POST /debug/repos/{id}/subscriptions`, `DELETE .../{sub}` | Subscribe RepoHub directly, without the GitHub checks |
| `GET /debug/repos/{id}`, `GET /debug/installations/{id}` | What a `RepoHub` or `Installation` object holds |
| `GET /debug/control`, `POST /debug/control/redeliver` | What `Control` holds; one run of the redelivery job, now (a dry run unless `?confirm=production`) |

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

#### As built in the prototype

`packages/server/src/control.ts`, with the cron in `scheduled` in
`src/worker.ts`. Where it differs from the above:

- **The work happens in Control**, not the cron handler: `scheduled`
  makes one RPC, `Control.redeliver()`, which signs the JWT, lists and
  redelivers. A cron invocation gets 10 ms of CPU on the free plan; a
  Durable Object gets far more, its SQLite keeps the state, and an
  in-memory guard stops runs overlapping.
- **The cron is on production only** (`*/10 * * * *` under
  `env.production.triggers`; the top level has `"crons": []`). Both
  Workers use the same App, whose webhooks go to production, so a cron
  on the test server would redeliver the same failures twice. On the
  test server `POST /debug/control/redeliver` runs the job by hand. It's
  a dry run by default: it scans (moving the cursor and queueing
  failures) and lists what it would redeliver. Calls of the same kind
  share a run under way; a real run waits for a dry one, and the other
  way round. Only with
  `?confirm=production` does it redeliver, to the App's webhook URL,
  which is production's. The free plan allows 5 cron triggers an
  account.
- **Delivery IDs** are int64s already past 2^53 (about 3.85e18 in
  October 2026), so they never become JS numbers: the list is parsed
  with each `id` kept as its digits, and they're stored and compared as
  20 zero-padded digits, which sort like the numbers. RPC results and
  `/debug/control` give them as strings.
- **The cursor** is a delivery ID: everything up to it has been looked
  at. A run lists deliveries newest first (`per_page=100`, following
  `Link: rel="next"`) until it reaches the cursor, or 3 days back, or 1
  hour back on the very first run. A scan that needs more than 3 pages
  saves its top and the next page's URL and carries on next run; the
  cursor moves to the top only when a scan finishes. State is saved
  after every page, so a run that fails (GitHub 5xx, say) resumes where
  it stopped. Deliveries less than a minute old are left for the next
  run, since one GitHub is still waiting on may be listed late. A saved
  page link that GitHub rejects with a 4xx restarts the scan from the
  top, with the cursor unchanged.
- **What's redelivered:** a GUID with a failed attempt (status 5xx, 429
  or no response) and no later successful one. The Worker's own refusals
  (400, 401, 413) aren't. Since a GUID that failed can only succeed on a
  redelivery, only successful redeliveries are written down during a
  scan; a first-time success, the usual case, costs no row writes.
  Failures go to a `queue` table; each run asks GitHub to redeliver the
  oldest 10 (`POST .../attempts`), and the rest wait. A redelivery
  GitHub accepts leaves the queue; if it fails as well, that's a new
  failed delivery for a later scan. At most 3 redelivery requests per
  GUID, counting ones GitHub refused with a 422 or 5xx, so one bad row
  can't block the queue: a 422 moves on to the next row, a 5xx or 429
  stops the run's redeliveries (a 429 isn't counted), and a 400 or 404
  drops the GUID. Two 422s in a row also stop the run, since GitHub may
  mean the whole endpoint ("has been spammed"); otherwise one bad
  stretch could use up every row's attempts in 3 runs. Counting a 5xx
  is a trade-off: a GitHub outage spends one attempt a run on the row at
  the head of the queue (and can drop it after 3 runs), but without it a
  row GitHub always fails on would block the queue for 3 days. After a
  422 on an `installation` or `installation_repositories` row, that
  installation's later rows of those events wait for the next run, so
  they stay in order. Listing and redelivering fail separately, so a
  listing error doesn't hold up what's already queued.
- **Installation events.** `Installation.onEvent` doesn't dedupe or
  order events, so a failed `installation` event (say `suspend`)
  redelivered after a newer one for the same installation succeeded
  (`unsuspend`) would revoke watches wrongly. The deliveries list
  carries `event` and `installation_id`, so a failed `installation`
  delivery isn't queued when the scan has seen a newer successful
  `installation` delivery for that installation, and one already queued
  is dropped when such a delivery turns up. Only original deliveries
  count as newer: a redelivery has a new ID but carries an old event.
  That holds only within a scan, and a newer one that lands after the
  old one was redelivered can't undo it. `installation_repositories` is
  still redelivered: the list doesn't say which repos an event was
  about, so a later `added` can't be told apart from one that undoes a
  failed `removed`; at worst a re-added repo's watches are revoked.
- So a run makes at most 13 subrequests, and a missed delivery is
  redelivered 1 to 11 minutes after it failed, or later when more than
  10 are queued.
- **Throughput ceiling:** a run scans at most 300 deliveries, so the job
  keeps up with up to 300 webhooks per 10 minutes (about 43,000 a day).
  Above that, scans fall further behind each run.

## Credentials

### What the server holds

| Name | Kind | Purpose |
|---|---|---|
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_CLIENT_ID` | vars | Public identifiers |
| `GITHUB_APP_PRIVATE_KEY` | secret | Signs App JWTs (RS256). Stored as PKCS#8 PEM, since Web Crypto can't import GitHub's PKCS#1; setup converts it. |
| `GITHUB_CLIENT_SECRET` | secret | Checking user tokens (`POST /applications/{client_id}/token`) and the refresh proxy |
| `GITHUB_WEBHOOK_SECRET` | secret | Webhook HMAC. `GITHUB_WEBHOOK_SECRET_OLD` during rotation. |
| `TICKET_KEY` | secret | HMAC for WebSocket tickets. `TICKET_KEY_OLD` during rotation; tickets live 60 seconds, so it can go a minute after the switch. |
| `DEBUG_TOKEN` | secret | Development only: turns on the `/debug` routes. Unset in production. |
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
  is the JSON `{acct, inbox, key, exp, nonce}` (`exp` in Unix seconds,
  60 seconds ahead) and the HMAC is SHA-256 over `wt1.<payload>`, in
  base64url. The Worker
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

### As built in the prototype

In `packages/server/src/repo-hub.ts` (schema 5: the `checks` and
`rollups` tables, which are caches, so a database from before 5 has
them dropped and made afresh; test servers had an earlier shape of them
under "3"), fed by internal kinds from `src/webhook/normalise.ts`, which
come after a payload's delivered events so those keep their IDs. The
`data` of both kinds is the CLI's (`packages/cli/src/diff.ts`). Where it
differs from the above:

- **Watched** means having a PR subscription. Since `prs` also holds PRs
  kept only for repository-wide `base` and `author` filters, rollups,
  mergeability checks, `base.advanced` and check pruning all look for a
  subscription, not just a row.

- **Facts.** `check_run.created` gives `check.started` (run ID, name,
  suite ID, App ID), or `check.completed` for a run created already
  finished; `check_run.completed` gives the existing `check.completed`
  (now with suite and App IDs); a `pending` status gives `check.started`
  (statuses carry their GitHub ID); and `check_suite` `requested`,
  `rerequested` and `completed` give `check_suite.updated`.
- **Cost.** `check_run.created`, pending statuses and `check_suite` now
  reach RepoHub, for unwatched repos too: one Durable Object request
  each, answered without writes. A delivery made only of `check.started`
  and `check_suite.updated` doesn't count against the repo's ingest
  limit, since nothing in it can be delivered. The Worker could skip
  those requests for unwatched repos by caching, per isolate, RepoHub's
  `no_subscriptions` answers for a minute; not built. Meta rows are
  written only when their value changes, so the repo name and
  installation set on each delivery cost nothing after the first.
- **Which checks are kept.** Every check fact for a repo with any
  subscription, not only watched heads, because a push's first checks
  can arrive before the `synchronize` webhook; rows for SHAs that are no
  longer a watched head are pruned a day after RepoHub last heard of
  them (`seen_at`, its own clock). A `pr.pushed` works out the new
  head's rollup straight away.
- **Sending.** A finished rollup is sent from the alarm once it has
  stayed finished and unchanged for 20 seconds (`rollups.settle_at`,
  moved on by every change); a new check starting meanwhile cancels it. It's sent when it differs from the
  last one sent to that PR (`rollups.head_sha` and `fingerprint`, the
  whole `data`): another result, more checks counted, or a new head,
  including a force-push back to an earlier one, as the CLI does. So a
  quick status that finishes before Actions creates its runs gives an
  early `checks.completed`, and the full one follows. The CLI's local
  mode re-sends on the same changes (`Memory.rollup.data`).
- **While throttled** a webhook's events aren't delivered, but PR facts
  (a push, a base change, a merge) and check facts are still recorded
  and rolled up, so a push or a run that finishes during a throttle
  doesn't leave a head stale or its rollup open. A merge or close still
  ends its PR's watches: each of the PR's subscriptions gets the
  `pr.merged` or `pr.closed` (if its kinds take it) and `watch.ended`,
  and repository-wide ones get nothing. Settled `checks.completed` and
  `merge.*` come from the alarm, so they are delivered even while the
  repo is throttled.
- **`check.failed` once per run.** A run created already finished gives
  `check.completed` and `check.failed` from its `created` webhook; if
  GitHub also sends `completed` for it, RepoHub delivers `check.failed`
  only for the delivery that recorded the run as finished, for the
  first time or with a new conclusion.
- **Suites are mostly seen through their runs.** GitHub sends
  `check_suite.requested` only to the suite's own App, so the queued,
  never-run suites the rule ignores rarely appear at all. A suite first
  seen through one of its runs counts as running until its
  `check_suite.completed` arrives, which keeps a workflow whose later
  jobs wait on earlier ones (their runs are created late) from finishing
  early. A late `created` doesn't undo a run's completion, but a run
  completed again with another conclusion (Apps can update their runs)
  replaces it if its `completed_at` is no older, and sends
  `check.failed` again if it failed;
  suites take the newest by GitHub's `updated_at`, and statuses by their
  increasing ID; on a tie the finished one wins. A finished run with no
  conclusion counts as neutral, never as a success.
- **Re-runs.** Only the latest run (highest ID) of each name within a
  suite counts, as in the CLI's `statusCheckRollup`. A re-run of a job in
  a suite that has already completed can make the rollup finish before
  any jobs that wait on it are created; best-effort, as PROTOCOL.md says.
- **IDs.** `checks.completed` is `repo:<id>.pr<N>.checks.<n>`, and
  `merge.conflict` and `merge.clean` are `repo:<id>.pr<N>.conflict.<n>`
  and `.clean.<n>`, where `<n>` counts the repo's derived events (meta
  `derived_seq`). Not the time: a Worker's clock stands still between
  I/O, so two sends could share a millisecond, and inboxes drop repeated
  IDs. `actor` is null; `links` are the PR's.
- **No baseline for checks.** A subscription starts with no rollup, so if
  a check is re-run on a head whose checks finished before the watch
  began, the rollup covers only the checks seen since (the CLI would know
  all of them). The mergeability baseline is the subscription's.
- **Mergeability triggers.** `pr.pushed` and `pr.base_changed` on a
  watched PR, and `base.advanced` (from a merged PR, with its base
  branch) when an open watched PR has that base, make the check due at
  once and give `UNKNOWN` its three retries again. A subscription makes
  it due in 15 minutes, or 10 seconds if the baseline wasn't definite.
  After a check, the next is 15 minutes on (60 s if GitHub failed, gave
  no token, or answered with errors or a body that isn't JSON; a failure
  never loses the rest of the alarm's work). A check asked for while one
  is waiting on GitHub is kept, with its retries reset
  (`merge_requests` counts the requests). Only PRs with a subscription
  are checked. Up to 50 PRs go in one query; each query is one call from
  the repo's bucket (`REPO_LIMITS.api`, 120 an hour, taken only once the
  token is in hand) and the installation's
  (`Installation.token(id, calls)`). Out of budget, the check waits until
  the bucket has the calls, or for the installation's `retry_after`.
- **The installation** is the `installation_id` meta row, set by `/v1`
  subscribing and by every webhook's `installation.id` (passed to
  `ingest`). Without one (subscriptions made through `/debug` without
  `installation_id`), no mergeability check runs.

## Limits

All limits but the per-IP ones are token buckets kept in SQLite
(`buckets` tables), refilled by elapsed time when read. That makes them exact and free: they live in an
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

`/v1/login` and `/v1/github/refresh` need no API key, and each costs a
GitHub call made with the App's client secret, so a flood of them could
get the App throttled by GitHub and stop everyone signing in. Each has
its own Rate Limiting binding (`LOGIN_RATE_LIMIT`, `REFRESH_RATE_LIMIT`
in `wrangler.jsonc`), keyed by `CF-Connecting-IP`:

| Endpoint | Limit | When exceeded |
|---|---|---|
| `/v1/login` | 10 a minute | `429 rate_limited`, `Retry-After: 60`, before any GitHub call |
| `/v1/github/refresh` | 10 a minute | the same |

A person signs in a handful of times ever, and a CLI refreshes its token
at most every 8 hours (when it next needs one for a private repo), so
these leave room for a large office behind one address while holding a
single address to well under GitHub's budget for the App. The binding's
counts are kept per Cloudflare location and are approximate, which is
enough for this. A flood from many addresses isn't stopped by it.

They fail open: without the binding (`wrangler dev`, the tests, a
self-hosted config from before it), without `CF-Connecting-IP`, or when
the limiter errors, the request goes through. The limit guards GitHub's
budget, not access (each request still needs a token GitHub issued to
this App), and failing closed would turn a missing binding into the
outage the limit is there to prevent. `/v1/meta` makes no GitHub call
and isn't limited.

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

*As built:* `watcheroni` and `@watcheroni/protocol` (built to JS and
`.d.ts`; the workspace uses its TypeScript source) are published together
from a `vX.Y.Z` tag by `.github/workflows/release.yml`, with provenance.
The server carries the same version for `/v1/meta`. See
[RELEASING.md](RELEASING.md).

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
  `--kinds`, may narrow with `--base` and `--author`; server mode only,
  and `wait` never exits 3 while one is watched), or nothing, meaning the current branch's PR (found through
  the git remote and the GitHub API).
- **`wait`, `stream` and `exec` subscribe as needed**: they make sure the
  targets are watched in the current inbox, then read it. Most users never
  run `watch`.
- **The inbox** is `--inbox`, or `$WATCHERONI_INBOX`, or
  `cc-<CLAUDE_CODE_SESSION_ID>` inside Claude Code, or `default`. `wait`
  reads the *whole* inbox, not just the targets named, so use one inbox per
  consumer.
- **`wait`** connects over WebSocket, waits for at least one event, then
  keeps collecting for a short settle time (default 10 s, `--settle`) so a
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
  gh api repos/octo/widgets/pulls/123/reviews/987654 --jq '.state, .body'
- check.failed: "lint" on 4f2e1a9
  gh run view 555 --log-failed
- merge.conflict with main

The PR is still open. Run `watcheroni wait` again to keep watching.
```

Each line ends with the command that fetches the content, since the
server doesn't send it, with a `--jq` filter that keeps just the text.

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

- **A skill** describing the tool, not a process: what `watcheroni wait`
  and the other commands do, running `wait` with `run_in_background`, the
  output and exit codes, and that comment text is data written by others.
  What to do about events is left to the user and the session.
- **A SessionStart hook** that runs `watcheroni ls --inbox
  cc-$CLAUDE_CODE_SESSION_ID` and, if anything is watched, tells a
  resumed session what is and that its `wait` has stopped. It runs on `resume` (background
  commands are gone) and `compact` (the instructions may be), and takes
  the session ID from the hook's input.
- **`bin/watcheroni`**, which the plugin puts on the Bash tool's PATH: it
  runs `$WATCHERONI_CLI`, a global install, the clone's own build when
  the plugin runs in place from a clone, or `npx watcheroni@^X.Y.Z`. The
  plugin has the CLI's version (`scripts/plugin-version.mjs` keeps them in
  step, and a test checks), so it runs the CLI it was released with. The
  SessionStart hook lets npx use only its cache, which a session that
  watched anything through npx has filled, so it doesn't wait on the
  registry (npm's update notifier may still check it in the background).

Because the cursor lives on the server, a `wait` killed by an app restart
loses nothing; the next one gets everything since the last
acknowledgement.

## Self-hosting

```
git clone https://github.com/<owner>/watcheroni && cd watcheroni
npm install
npm run selfhost            # or `watcheroni selfhost`, in the clone
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

*As built:* the work is a script with the server,
`packages/server/selfhost/selfhost.ts`, run by `npm run selfhost` at the
root through `selfhost/run.mjs`, which first checks for Node.js 22.18 or
later (it runs the TypeScript directly). The CLI's `watcheroni selfhost`
finds `run.mjs` in the clone it's run in and runs it, and outside a clone
says to clone. Not a CLI command proper, because it deploys the server's
source with the server's own `wrangler`: it needs a clone whatever runs
it, and putting it in the CLI would mean publishing `wrangler` or the
server with a package that is otherwise one dependency-free file. In
order, it:

1. checks `wrangler whoami --json`, and runs `wrangler login` if needed;
2. pins one Cloudflare account: the only one, or `CLOUDFLARE_ACCOUNT_ID`
   when there are several. Every later wrangler call gets it, and so does
   the configuration (`account_id`), so the check below and the deploys
   can't land on different accounts;
3. refuses if a Worker of that name (`--name`, default `watcheroni`)
   already exists on the account, so it can't deploy over a real server.
   Once that check passes it writes `.selfhost-app.json` (mode 0600,
   gitignored) with the Worker's name and account;
4. deploys once with empty GitHub vars, to learn the Worker's workers.dev
   URL, which the App's URLs need, and marks the file `created` with the
   version ID the deploy made. Only that mark lets a later run skip the
   check, and only while the Worker's deployment history
   (`wrangler deployments list`) still has the recorded version, which
   is updated after the secrets and the last deploy. A Worker deleted
   and made again by someone else, or a hand-edited file, fails that;
5. serves a page on `127.0.0.1` (answering only requests whose `Host` is
   `127.0.0.1:<port>`, against DNS rebinding) that posts the manifest to
   GitHub (`--org` for an organization's App; private unless `--public`;
   named `watcheroni-<workers.dev subdomain>` unless `--app-name`), and
   exchanges the code GitHub redirects back with at
   `POST /app-manifests/{code}/conversions`. The code works once, so if
   the exchange fails it says to delete the App GitHub made and start
   again. The App's details and generated keys go into
   `.selfhost-app.json` straight away, since GitHub shows the key once;
6. sets the five secrets with `wrangler secret put`, values on stdin;
7. deploys with `GITHUB_APP_ID`, `GITHUB_CLIENT_ID` and `GITHUB_APP_SLUG`;
8. has the user tick "Enable Device Flow" on the App's settings page,
   since a manifest can't, and checks it by starting a device flow until
   GitHub stops answering `device_flow_disabled`;
9. records the Worker's name, account and newest version in
   `.selfhost-worker.json` (gitignored; not in `wrangler.selfhost.json`,
   since wrangler warns about fields it doesn't know), deletes
   `.selfhost-app.json`, checks `/v1/meta` reports the new client ID, and
   sets `server` in `~/.config/watcheroni/config.json`.

A run that stops part way carries on from `.selfhost-app.json` with its
Worker, account and App; if its first deploy never finished, it checks
again that no Worker of that name exists. `--update` deploys only if
`.selfhost-worker.json` matches the configuration's name and account and
that Worker's history has the recorded version, and records the new one,
so an edited `wrangler.selfhost.json` can't send it to another Worker. A
first deploy that exits 0 is recorded before anything else is checked,
even its URL. Cloudflare lists only the last ten deployments, so ten made
outside selfhost (deploys by hand, secret changes, rollbacks) also make
it refuse; `--trust-worker` shows the deployments and, once the Worker's
name is typed back at a terminal, records the newest. Later runs keep to the Worker and account the
first one chose (from that file, or from the configuration once setup
has finished): a different `--name` or `CLOUDFLARE_ACCOUNT_ID` is
refused, as is a state file that doesn't name its Worker and account.

The Worker's configuration is `packages/server/wrangler.selfhost.json`,
gitignored, made from `wrangler.jsonc`'s production environment (its
bindings and crons) under the deployer's name and account, on
workers.dev, with their App's vars. It's remade on every run, so `npm
run selfhost -- --update` after a pull picks up new bindings, migrations
and crons and deploys. `--dry-run` prints each command, the
configuration and the manifest, and changes nothing. Its tests
(`packages/server/selfhost/test`) run in Node with Cloudflare and GitHub
stubbed, including the local callback server; a real run against a
fresh Cloudflare account hasn't been done yet. A custom domain is by
hand: add a route to the configuration and change the App's webhook and
Setup URLs.

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
   *Done on 2026-10-27:* the object hibernated with three clients and a
   bridge attached, with no duration billed for the idle minutes (see
   `packages/server/README.md`), and webhook CPU is under 4 ms for any
   realistic payload (see "Webhook CPU"). Background Bash survives for
   hours: in the Claude Code desktop app, one `watcheroni wait --timeout
   6h` ran in the background for the full six hours (04:09 to 10:09 UTC)
   and exited with its timeout, while beside it a `wait` loop driven by
   the plugin's skill ran on three busy public PRs for the same six hours:
   ten runs, four of them hour-long timeouts, each event arriving within
   one poll of GitHub's timestamp (an approval at 08:11:51, reported in
   the run that ended 08:12:25), and one PR's merge ending its watch.
   Stopping a running `wait` released the inbox lock. What reads badly
   to an agent: each reply in a review thread arrives as its own
   "commented" `review.submitted` plus a `review_comment.created`, so
   three replies make six lines; `thread.resolved` doesn't say which
   thread; and the printed `gh api` commands return whole JSON objects
   where a `--jq` filter for the body would do (all three fixed since:
   `wait` prints a reply's body-less review only when its replies are
   filtered out, threads carry `path`, `line` and their first
   `comment_id`, and the commands filter with `--jq`; see PROTOCOL.md
   "Kinds"). A failed
   `checks.completed` now prints `gh pr checks`, since its individual
   `check.failed` events may predate the watch.
2. **CLI in local mode only** (`wait`, `stream`, `exec` polling GitHub).
   Useful on its own; replaces Auto-Fix for one user straight away.
   *Built on 2026-10-27* in `packages/cli`, together with
   `packages/protocol`, which now holds the shared types.
3. **Server MVP:** webhook → RepoHub → Account → WebSocket for PR
   subscriptions, device-flow login, API keys. Develop with `wrangler dev`
   and `gh webhook forward` or smee relaying a test App's deliveries.
   *RepoHub built:* ingest, PR, head-SHA and repo-wide matching, the
   outbox, the end of a watch and the ingest limit (see "As built in the
   prototype" under "RepoHub").
   *`/v1` subscriptions built on 2026-10-28:* the Installation object (App
   JWTs, encrypted installation tokens, the API budget, `watch.revoked`
   on uninstall, suspend or removed repos), `POST / GET / DELETE
   /v1/inboxes/{name}/subscriptions` with the installation and
   private-access checks and a PR baseline, and the CLI subscribing its
   targets (sending the saved GitHub token only for private repos,
   refreshing it when expired) and polling locally whatever the server
   won't watch. Deployed to the test Worker and checked there; no repo has
   the App installed yet, so a live subscription has only been seen to
   answer `app_not_installed`. *Finished 2026-10-28:* `/verify` and the
   CLI renewing private subscriptions, `watch.expired` for inboxes nobody
   reads, `watch.unverified` when access lapses or is lost, and
   `github_app_authorization` revoking the user's API keys. Subscribing
   has been checked live on production with a private repo
   (thepaul/shinycode-website); all of it is deployed there.
4. **Derived events** (checks rollup, mergeability), limits, redelivery.
   *Derived events built on 2026-10-28* (see "As built" under "Derived
   events"), tested with GitHub stubbed. The rollup was checked on the
   test Worker with signed webhooks; mergeability against real GitHub
   still needs an open PR on a repo with the App installed.
5. **Publish:** the hosted App, `watcheroni` and `@watcheroni/protocol` on
   npm, the Claude Code plugin, `selfhost`.
6. Repo-wide subscriptions; recipes for `exec` (desktop notifications,
   ntfy, Slack incoming webhooks) before any built-in notification
   support.
   *Repo-wide subscriptions built:* `base` and `author` on the server
   (see "As built" under "RepoHub"), and `owner/repo` targets in the CLI
   with `--kinds`, `--base` and `--author`, in server mode only. A
   repo-wide watch is remembered in the local inbox (`ls`, `unwatch`) and
   keeps `wait` from exiting 3.

## Open questions

- **Who may watch a public repo?** *Decided 2026-10-29:* anyone signed
  in may subscribe to a public repo that has the App installed. They could
  poll it instead, which would cost GitHub and the server more for the
  same result; the API limits keep it from being easy to abuse. A
  "collaborators only" setting can wait until an owner asks for one.
- **Is 7-day re-verification for private repos acceptable?** It's
  automatic for the CLI but is work for every other client.
- **Hot accounts.** A bot account with thousands of subscriptions puts all
  its deliveries through one Account object. Fine at these limits;
  splitting inboxes into their own objects is the way out if needed.
- **Whether `checks.completed` is reliable enough** on repos with unusual
  CI (external status checks, apps that create suites late). *2026-10-29:*
  left until someone reports trouble; nobody is expected to build
  anything critical on it.

## Sources

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Durable Objects WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Generating a user access token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [Registering a GitHub App from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
- Earlier sources are in [pr-watch-design.md](pr-watch-design.md).
