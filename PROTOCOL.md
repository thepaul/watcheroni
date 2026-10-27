# watcheroni protocol, version 1

Draft, 2026-10-26.

This is the contract between a watcheroni server and its clients. The
`watcheroni` CLI is one client. Anything that speaks HTTPS and WebSocket
can be another: an editor extension, a chat bot, a CI job, a Claude Code
plugin, a script using `curl`. Nothing here depends on the CLI.

The words MUST, SHOULD and MAY are used as in RFC 2119.

## Concepts

- **Account.** One GitHub user. Created the first time that user logs in.
- **API key.** The service's own credential for an account
  (`wk1_...`). A user may have several (one per machine or client), each
  revocable.
- **Inbox.** A named, ordered log of events belonging to an account, with
  a cursor. One consumer reads one inbox. A Claude Code session, a chat
  bot and a laptop script would each use their own inbox, so each sees
  every event once. Names are chosen by the client.
- **Subscription.** A rule that copies matching events from one
  repository into one inbox: "reviews and check failures on
  `octo/widgets#123`, into inbox `cc-5f2e`".
- **Event.** A small JSON object describing something that happened on
  GitHub. It carries **metadata and links, never content**: no comment
  text, no titles, no code. Clients fetch content from GitHub with their
  own credentials.
- **Sequence number (`seq`).** Each inbox numbers its events 1, 2, 3, ...
  with no reuse. A client's position in an inbox is the last `seq` it
  has handled.
- **Acknowledged position (`acked`).** The server stores one position per
  inbox, moved forward only by the client. A client with no local state
  (a new process, another machine) starts reading from there.

Delivery is **at least once**. A client can see an event twice (after a
reconnect, or when two readers share an inbox) and SHOULD drop duplicates
by `id`.

## Discovery

```
GET /v1/meta
```

No authentication. Returns everything a client needs to start:

```json
{
  "protocol": 1,
  "server": "watcheroni/0.1.0",
  "features": ["ws", "longpoll", "repo_scope"],
  "github": {
    "app_slug": "watcheroni",
    "client_id": "Iv23liABCDEF123456",
    "install_url": "https://github.com/apps/watcheroni/installations/new",
    "web_url": "https://github.com",
    "api_url": "https://api.github.com"
  },
  "limits": {
    "inboxes_per_account": 50,
    "subscriptions_per_account": 200,
    "max_wait_seconds": 300,
    "max_ttl_seconds": 2592000,
    "private_verify_seconds": 604800
  }
}
```

Clients MUST ignore fields and features they don't recognise.

## Authentication

### Signing in

The server never stores a user's GitHub token. Signing in proves who the
user is, once, and exchanges that for an API key.

1. The client runs GitHub's
   [device flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-device-flow-to-generate-a-user-access-token)
   **directly with GitHub**, using `github.client_id` from `/v1/meta`. No
   client secret is needed. The result is a GitHub App user access token
   (`ghu_...`), usually with a refresh token.
2. The client sends it to the server:

   ```
   POST /v1/login
   Content-Type: application/json

   {"github_token": "ghu_...", "label": "paul's laptop"}
   ```

   The server checks with GitHub that the token was issued to this
   server's App, reads the user's ID and login from that check, and
   forgets the token. Tokens from anywhere else (personal access tokens,
   `gh auth token`, other Apps) are rejected with `github_token_invalid`,
   so a user can't hand over a broad token by mistake.

   ```json
   {
     "api_key": "wk1_1234567_Q2hhbmdlIG1lIHRvIGEgcmVhbCByYW5kb20ga2V5",
     "key_id": "key_01JBQ3...",
     "account": {"id": 1234567, "login": "paul"}
   }
   ```

   The key is shown only once.

3. The client keeps the GitHub token and refresh token **locally**. It
   needs them again only to subscribe to private repositories (see
   below).

### Using the API key

Every other request carries:

```
Authorization: Bearer wk1_...
```

The key's format is `wk1_<account id>_<secret>`; clients MUST treat it as
opaque.

### Refreshing the GitHub token

GitHub App user tokens expire after 8 hours, and refreshing one needs the
App's client secret, which clients don't have. The server offers a
stateless proxy that adds the secret and stores nothing:

```
POST /v1/github/refresh
{"refresh_token": "ghr_..."}
```

The response is GitHub's own response body (`access_token`,
`refresh_token`, `expires_in`, ...), passed through unchanged. No API key
is needed, since the refresh token is the credential.

### Keys

```
GET    /v1/keys              list keys (id, label, created_at, last_used_at)
DELETE /v1/keys/{key_id}     revoke one; DELETE /v1/keys/current revokes the caller's
```

If the user revokes the App's authorization in GitHub's settings, the
server revokes all of that account's keys.

## Inboxes

```
PUT    /v1/inboxes/{name}        create, or touch if it exists (idempotent)
GET    /v1/inboxes               list
GET    /v1/inboxes/{name}        details
DELETE /v1/inboxes/{name}        delete, with its subscriptions and events
```

Names: 1-64 characters from `[A-Za-z0-9._-]`. An inbox and its
subscriptions are deleted after 30 days in which nothing read it.

```json
{
  "name": "cc-5f2e9a",
  "created_at": "2026-10-26T17:40:00Z",
  "head": 42,
  "acked": 40,
  "oldest": 1,
  "subscriptions": 3,
  "last_read_at": "2026-10-26T18:02:11Z"
}
```

`head` is the newest `seq`, `oldest` the oldest still kept. An inbox keeps
at most 1,000 events and at most 7 days of them.

## Subscriptions

### Creating

```
POST /v1/inboxes/{name}/subscriptions
X-GitHub-Token: ghu_...            (needed for private repositories only)

{
  "repo": "octo/widgets",
  "pr": 123,
  "kinds": ["pr.*", "review.*", "comment.created", "check.failed",
            "checks.completed", "merge.*"],
  "ignore": {"self": true, "bots": false, "actors": ["dependabot[bot]"]},
  "ttl_seconds": 604800
}
```

- `repo`: `owner/name`. Required.
- `pr`: a pull request number. Leave it out for a **repository-wide**
  subscription, which then MUST name at least one kind and MAY narrow with
  `"base": "main"` (PRs targeting that branch) or `"author": "paul"`.
- `kinds`: event kinds or globs (`review.*`). Leaving it out means every
  kind for PR subscriptions.
- `ignore.self`: drop events caused by the account's own GitHub user.
  Default `false`.
- `ttl_seconds`: how long the subscription lives without anyone reading
  its inbox. Default 7 days, maximum `limits.max_ttl_seconds`. Each read of
  the inbox restarts the clock.

The server checks, in order:

1. The App is installed on the repo. If not: `409 app_not_installed`,
   with `install_url`. Clients SHOULD fall back to polling GitHub
   themselves (see "Clients without the server" below).
2. For a **private** repo: `X-GitHub-Token` is present, was issued to this
   App for the same GitHub user as the API key, and can read the repo.
   Otherwise `401 github_token_required` or `403 repo_access_denied`. The
   token is used for this check and then forgotten.
3. Quotas (see "Limits").

A PR subscription also fetches the PR's current state, so the server has a
baseline for derived events (checks, merge conflicts).

Creating is idempotent: the same inbox, repo, PR and filter returns the
existing subscription with `200` instead of `201`.

```json
{
  "id": "sub_01JBQ4...",
  "inbox": "cc-5f2e9a",
  "repo": {"id": 1296269, "full_name": "octo/widgets", "private": true},
  "pr": 123,
  "kinds": ["pr.*", "review.*", "comment.created", "check.failed",
            "checks.completed", "merge.*"],
  "ignore": {"self": true, "bots": false, "actors": ["dependabot[bot]"]},
  "created_at": "2026-10-26T17:41:00Z",
  "expires_at": "2026-11-02T17:41:00Z",
  "verified_until": "2026-11-02T17:41:00Z",
  "state": "active",
  "baseline": {"state": "open", "head_sha": "4f2e1a9...", "mergeable": "mergeable"}
}
```

### Private repositories stay verified

For a private repo the server can't watch for the user losing access, so
access is re-checked at least every `limits.private_verify_seconds`
(7 days). `verified_until` says when. Before then, the client renews:

```
POST /v1/inboxes/{name}/subscriptions/{id}/verify
X-GitHub-Token: ghu_...
```

If it isn't renewed in time, the subscription ends with a
`watch.unverified` event.

### Other operations

```
GET    /v1/inboxes/{name}/subscriptions
GET    /v1/inboxes/{name}/subscriptions/{id}
DELETE /v1/inboxes/{name}/subscriptions/{id}
```

### When subscriptions end

A subscription ends, after delivering a final event, when:

| Reason | Final event |
|---|---|
| The PR is merged | `pr.merged`, then `watch.ended` |
| The PR is closed | `pr.closed`, then `watch.ended` |
| Nobody read the inbox for `ttl_seconds` | `watch.expired` |
| Private access not re-verified | `watch.unverified` |
| The App was uninstalled, or the repo removed from it | `watch.revoked` |
| The repository was deleted or transferred away | `watch.revoked` |

`watch.ended` tells an agent it can stop waiting. A client that wants to
keep watching a reopened PR subscribes again.

## Reading events

There are two ways to read an inbox. Both give the same events in the
same order with the same `seq`s.

### Long-polling

```
GET /v1/inboxes/{name}/events?after=40&wait=300&limit=100
```

- `after`: return events with `seq` greater than this. Leave it out to
  start from `acked`.
- `wait`: seconds to wait if nothing is there yet, up to
  `limits.max_wait_seconds`. `0` (the default) returns at once.
- `limit`: at most this many events, up to 500.

```json
{
  "events": [ ... ],
  "next": 42,
  "head": 42,
  "acked": 40
}
```

`next` is the value to pass as `after` next time. An empty `events` list
after a wait is normal, not an error. The response doesn't move `acked`;
see "Acknowledging".

### WebSocket

1. Get a ticket (lives 60 seconds, usable once):

   ```
   POST /v1/inboxes/{name}/ticket
   → {"ticket": "wt1....", "url": "wss://watcheroni.dev/v1/inboxes/cc-5f2e9a/ws?ticket=wt1...."}
   ```

   Clients that can set headers on a WebSocket handshake MAY instead send
   `Authorization: Bearer wk1_...` to the `ws` URL directly.
2. Connect to `url` with subprotocol `watcheroni.v1`.
3. Messages are JSON text frames.

**Client to server:**

```json
{"type": "hello", "after": 40}
{"type": "ack", "seq": 42}
```

Send `hello` first. Leave out `after` to start from `acked`. Events can
then arrive at any time.

Send the text frame `ping` at least every 60 seconds; the server answers
`pong`. (This is answered without waking the server's storage, so it
costs nothing.) Connections silent for 120 seconds may be closed.

**Server to client:**

```json
{"type": "ready", "inbox": "cc-5f2e9a", "head": 42, "acked": 40}
{"type": "events", "events": [ ... ]}
{"type": "error", "code": "rate_limited", "detail": "..."}
```

After `ready`, the server sends everything after the client's position,
then new events as they arrive.

**Close codes:** `4001` key revoked or ticket invalid (don't retry
without signing in again); `4004` inbox deleted; `4029` too many
connections for this account; `1012` server restarting (reconnect). For
any other close, reconnect with backoff (1 s doubling to 60 s, with
jitter) and send `hello` with your current position.

### Acknowledging

```
POST /v1/inboxes/{name}/ack
{"seq": 42}
```

Or `{"type": "ack"}` over the WebSocket. Moves `acked` forward (never
back). Clients SHOULD acknowledge once they have *handled* events, not
when they receive them, so a crash means seeing them again rather than
losing them.

### Gaps

If a client's position is older than the oldest kept event, the first
event it gets is:

```json
{"seq": 501, "kind": "inbox.gap", "data": {"missed_after": 40, "resumed_at": 502}, ...}
```

The client should re-read the state of what it watches from GitHub
directly.

## Events

### Envelope

```json
{
  "v": 1,
  "seq": 42,
  "id": "d8a3f2c0-93b1-11ef-8f1a-0e2c5f2e9a11.0",
  "sub": "sub_01JBQ4...",
  "kind": "review.submitted",
  "at": "2026-10-26T17:42:10Z",
  "received_at": "2026-10-26T17:42:11Z",
  "repo": {"id": 1296269, "full_name": "octo/widgets"},
  "pr": 123,
  "actor": {"id": 583231, "login": "alice", "bot": false},
  "data": {"review_id": 987654, "state": "changes_requested"},
  "links": {
    "html": "https://github.com/octo/widgets/pull/123#pullrequestreview-987654",
    "api": "https://api.github.com/repos/octo/widgets/pulls/123/reviews/987654"
  }
}
```

- `v`: envelope version, always `1` in this protocol version.
- `id`: stable across retries and redeliveries. For events from a webhook
  it's the GitHub delivery ID plus an index; for derived events it's
  derived from what was detected. Use it to drop duplicates.
- `sub`: which subscription matched. If two subscriptions in one inbox
  match the same event, it's delivered once, naming the first.
- `at`: when it happened on GitHub, if GitHub says; else `received_at`.
- `pr`: the PR number, or `null` for events not about a PR.
- `actor`: who caused it, or `null` for derived events.
- `data`: depends on `kind` (below). Fields are metadata only.
- `links.api`: the GitHub REST URL to fetch the content, where there is
  one.

Clients MUST ignore unknown fields, and MUST accept (and SHOULD pass
through or ignore) unknown kinds. New kinds and fields are added without
changing the protocol version.

### Kinds

**Pull requests** (from `pull_request`):

| Kind | `data` |
|---|---|
| `pr.opened` | `head_sha`, `base`, `draft` |
| `pr.pushed` | `before`, `after` (head SHAs), `forced` |
| `pr.ready_for_review` | |
| `pr.converted_to_draft` | |
| `pr.review_requested` | `reviewer` (login or `team:slug`) |
| `pr.closed` | |
| `pr.merged` | `merge_sha` |
| `pr.reopened` | |
| `pr.base_changed` | `from`, `to` |

**Reviews and comments** (from `pull_request_review`,
`pull_request_review_comment`, `pull_request_review_thread`,
`issue_comment`):

| Kind | `data` |
|---|---|
| `review.submitted` | `review_id`, `state` (`approved`, `changes_requested`, `commented`) |
| `review.dismissed` | `review_id` |
| `review_comment.created` | `comment_id`, `review_id`, `path`, `line`, `in_reply_to` |
| `thread.resolved` | `thread_node_id` |
| `thread.unresolved` | `thread_node_id` |
| `comment.created` | `comment_id` |

A review with several comments produces one `review.submitted` and one
`review_comment.created` per comment. Clients that wake an agent SHOULD
debounce, since these arrive together.

**Checks** (from `check_run`, `check_suite`, `status`, `workflow_run`):

| Kind | `data` |
|---|---|
| `check.failed` | `head_sha`, `name`, `check_run_id` or `status_context`, `conclusion` (`failure`, `timed_out`, `action_required`, `startup_failure`) |
| `checks.completed` | `head_sha`, `result` (`success`, `failure`, `cancelled`), `failed` (names, at most 20), `counts` (`{success, failure, cancelled, skipped, neutral}`) |
| `workflow.completed` | `head_sha`, `run_id`, `workflow`, `conclusion` |

`check.failed` arrives as soon as one check fails. `checks.completed` is
**derived**: it's sent when every check on the PR's current head has
finished, and again if a re-run changes the result. It is best-effort,
because GitHub has no event meaning "all checks are done": a check that
starts late can follow it.

**Mergeability** (derived; no GitHub webhook exists for this):

| Kind | `data` |
|---|---|
| `merge.conflict` | `head_sha`, `base_sha` |
| `merge.clean` | `head_sha`, `base_sha` (sent only after a conflict) |

Usually within a minute of the change, at most about 15 minutes.

**Issues** (repository-wide subscriptions, and comments on issues):

| Kind | `data` |
|---|---|
| `issue.opened`, `issue.closed`, `issue.reopened` | `issue` (number) |
| `issue.labeled` | `issue`, `label` |

**About the subscription or inbox:**

| Kind | `data` |
|---|---|
| `watch.ended` | `reason` (`merged`, `closed`) |
| `watch.expired`, `watch.unverified`, `watch.revoked` | `reason` |
| `repo.throttled` | `until` (time). The repo is sending more events than its limit; events are being dropped until then. Poll GitHub directly meanwhile. |
| `repo.unthrottled` | `dropped` (count) |
| `inbox.gap` | `missed_after`, `resumed_at` |

`watch.*` and `repo.*` are always delivered, whatever `kinds` says.

## Errors

Errors use `application/problem+json`
([RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)) with a stable `code`:

```json
{
  "type": "https://watcheroni.dev/errors/app_not_installed",
  "title": "The watcheroni App isn't installed on octo/widgets",
  "status": 409,
  "code": "app_not_installed",
  "install_url": "https://github.com/apps/watcheroni/installations/new"
}
```

| Status | `code` | Meaning |
|---|---|---|
| 400 | `invalid_request` | Malformed body or parameters; `detail` says which. |
| 401 | `unauthorized` | Missing, unknown or revoked API key. |
| 401 | `github_token_required` | Private repo, no `X-GitHub-Token`. |
| 401 | `github_token_invalid` | Token not issued to this App, expired, or for a different user. |
| 403 | `repo_access_denied` | The user can't read the repo. |
| 404 | `not_found` | No such repo, PR, inbox or subscription. |
| 409 | `app_not_installed` | Includes `install_url`. |
| 409 | `pr_not_open` | Subscribing to a merged or closed PR. |
| 422 | `quota_exceeded` | Too many inboxes or subscriptions; `detail` says which. |
| 429 | `rate_limited` | Includes `Retry-After`. |
| 503 | `unavailable` | Try again later; includes `Retry-After`. |

Clients MUST handle any `code` they don't know by its HTTP status.

## Limits

Responses to authenticated requests carry
`RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers for
the account's request budget. A `429` always carries `Retry-After`
(seconds).

Limits apply per account, per repository and per IP address (for the
unauthenticated endpoints). The values are the server's choice and are
published in `/v1/meta`. Limits on a repository affect everyone watching
it; when a repository is throttled, its subscribers get `repo.throttled`.

## Clients without the server

When the server can't help (the App isn't installed, the server is down,
the repo is throttled), a client MAY poll GitHub itself and produce the
same event kinds, with its own `seq`s and an `id` prefixed `local:`. This
is outside the protocol; the CLI does it so its output looks the same in
both cases.

## Compatibility

- The path prefix `/v1` changes only for breaking changes.
- Within v1, the server may add endpoints, optional request fields,
  response fields, event kinds, `data` fields, error codes and features.
- Clients check `/v1/meta` `features` before using optional parts.
- Machine-readable definitions live in `packages/protocol/schema/`
  (JSON Schema for every request, response, message and event kind), with
  example payloads in `packages/protocol/fixtures/` that both the server
  and the CLI test against.
