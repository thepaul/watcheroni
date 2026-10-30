# Events

Every kind of event watcheroni sends, what it means, and where it comes
from: on the server, which GitHub webhook; in the CLI's local mode, which
change between two polls. The envelope (`id`, `at`, `actor`, `links`, ...)
is in [PROTOCOL.md](../PROTOCOL.md#envelope).

Events are notifications, not state. One GitHub webhook can become
several events or none, local mode sees only what changed between polls,
and some things have no event at all (see [Not tracked](#not-tracked)).
When an event makes the current state worth knowing, ask GitHub.

**Server** events come from the GitHub App's webhooks
(`packages/server/src/webhook/normalise.ts`), except `watch.*` and
`repo.*`, which the server makes itself (`packages/server/src/repo-hub.ts`).
A subscription on one PR gets events whose `pr` is that PR. A
repository-wide subscription gets every PR's events and the repo's
issues, narrowed by its `kinds` and by `base` and `author` if it has
them. Events whose `actor` a subscription's `ignore` covers aren't
delivered.

**Local mode** is the CLI polling GitHub itself, every 2 minutes by
default (`--interval`), when there's no server or the server won't watch
a PR. Each poll is one GraphQL query per PR (`packages/cli/src/snapshot.ts`);
`packages/cli/src/diff.ts` turns the difference from the last poll into
events. The first poll is the starting point and reports nothing. Local
mode watches single PRs only, never whole repositories. What it can
miss:

- changes that undo each other between two polls: a thread resolved and
  unresolved again, a draft marked ready and back, a review submitted and
  dismissed (no event at all), a check failing and then passing on a
  re-run of the same commit status;
- intermediate states: several pushes are one `pr.pushed`, and a check
  run completed twice with different conclusions reports the last one;
- anything beyond what one query reads: the last 100 reviews, review
  threads and PR comments, the last 100 comments in each thread, the
  first 50 review requests and the first 100 checks on the head commit;
- checks on a commit that is no longer the head by the next poll.

Its events' `at` is the time GitHub gives for reviews, comments and
checks, and the time of the poll for everything else. Their `id`s start
with `local:`.

## Pull requests

### `pr.opened`

A PR was opened.

`data`: `head_sha`, `base` (branch), `draft`.

**Server:** `pull_request` / `opened`. Only repository-wide subscriptions
see it, since a PR subscription starts on a PR that already exists.

**Local mode:** Not sent. Local mode watches PRs that already exist.

### `pr.pushed`

The PR's head branch moved: new commits, or a force-push.

`data`: `before`, `after` (head SHAs).

**Server:** `pull_request` / `synchronize`. Nothing says whether it was a
force-push.

**Local mode:** the head SHA differs from the last poll's. `before` is
the head at the last poll, so several pushes in one interval are one
event.

### `pr.ready_for_review`

A draft PR was marked ready for review.

`data`: none.

**Server:** `pull_request` / `ready_for_review`.

**Local mode:** the PR was a draft at the last poll and isn't now.

### `pr.converted_to_draft`

The PR was turned back into a draft.

`data`: none.

**Server:** `pull_request` / `converted_to_draft`.

**Local mode:** the PR wasn't a draft at the last poll and is now.

### `pr.review_requested`

Someone was asked to review the PR.

`data`: `reviewer` (a login, or `team:<slug>`).

**Server:** `pull_request` / `review_requested`, one per reviewer or team
asked, including a re-request.

**Local mode:** a reviewer or team in the PR's pending review requests
that wasn't at the last poll. A request made and withdrawn between polls
isn't seen; a re-request after a review is, since the review clears the
request.

### `pr.closed`

The PR was closed without merging. A `watch.ended` follows.

`data`: none.

**Server:** `pull_request` / `closed`, when the PR isn't merged.

**Local mode:** the PR was open at the last poll and is closed, not
merged, now.

### `pr.merged`

The PR was merged. A `watch.ended` follows.

`data`: `merge_sha` (may be `null`).

**Server:** `pull_request` / `closed`, when the PR is merged.

**Local mode:** the PR was open at the last poll and is merged now.

### `pr.reopened`

A closed PR was reopened.

`data`: none.

**Server:** `pull_request` / `reopened`. Only repository-wide
subscriptions see it: a PR subscription ends when its PR closes, and
can't be made on a closed PR.

**Local mode:** in principle, the PR wasn't open at the last poll and is
now. In practice a local watch ends when its PR closes, so this isn't
seen, and a PR closed and reopened between two polls looks unchanged.

### `pr.base_changed`

The PR's base branch was changed.

`data`: `from`, `to` (branch names).

**Server:** `pull_request` / `edited`, when the payload says the base
changed. Other edits (title, body) are dropped.

**Local mode:** the base branch differs from the last poll's.

## Reviews and comments

### `review.submitted`

A review was submitted. A reply in a review thread is a `commented`
review with no text of its own, so it arrives as a `review.submitted`
(`has_body: false`) with a `review_comment.created`.

`data`: `review_id`, `state` (`approved`, `changes_requested`,
`commented`), `has_body`.

**Server:** `pull_request_review` / `submitted`.

**Local mode:** a review that wasn't there at the last poll, unless it's
already dismissed. Pending reviews are left out until submitted.

### `review.dismissed`

A review was dismissed.

`data`: `review_id`.

**Server:** `pull_request_review` / `dismissed`. `actor` is whoever
dismissed it.

**Local mode:** a review that was there at the last poll is dismissed
now. `actor` is `null`.

### `review_comment.created`

A comment on the code: one of a review's comments, or a reply in a
thread.

`data`: `comment_id`, `review_id`, `path`, `line` (the original line
once the code under it has changed; `null` on the whole file),
`in_reply_to`.

**Server:** `pull_request_review_comment` / `created`, one per comment.
A review with several comments sends them separately from its
`review.submitted`.

**Local mode:** a comment in a review thread that wasn't there at the
last poll, and isn't part of a pending review.

### `thread.resolved`

A review thread was resolved.

`data`: `thread_node_id`, `path`, `line`, `comment_id` (the thread's
first comment).

**Server:** `pull_request_review_thread` / `resolved`.

**Local mode:** a thread that was there and unresolved at the last poll
is resolved now. A thread started and resolved between polls isn't seen.

### `thread.unresolved`

A resolved review thread was unresolved.

`data`: the same as `thread.resolved`.

**Server:** `pull_request_review_thread` / `unresolved`.

**Local mode:** a thread that was resolved at the last poll isn't now.

### `comment.created`

A comment on the PR's conversation (not on the code), or, for
repository-wide subscriptions, on an issue.

`data`: `comment_id`; on an issue, also `issue` (its number), with `pr`
`null`.

**Server:** `issue_comment` / `created`.

**Local mode:** a PR comment that wasn't there at the last poll.

## Issues

These reach repository-wide subscriptions without `base` or `author`,
since they're about no PR.

### `issue.opened`

An issue was opened.

`data`: `issue` (number).

**Server:** `issues` / `opened`.

**Local mode:** Not sent.

### `issue.closed`

An issue was closed.

`data`: `issue`.

**Server:** `issues` / `closed`.

**Local mode:** Not sent.

### `issue.reopened`

An issue was reopened.

`data`: `issue`.

**Server:** `issues` / `reopened`.

**Local mode:** Not sent.

### `issue.labeled`

A label was added to an issue (not to a PR).

`data`: `issue`, `label` (its name).

**Server:** `issues` / `labeled`.

**Local mode:** Not sent.

## Checks

Each check run or commit status reports as it finishes. Nothing says
that all of a commit's checks are done; after a check event,
`gh pr checks <n>` shows them all.

### `check.completed`

A check run or commit status finished, with any conclusion.

`data`: `head_sha`, `name`, `check_run_id` (a check run) or
`status_context` (a commit status), `workflow_run_id` (local mode only,
for a GitHub Actions job), `conclusion` (`success`, `failure`,
`cancelled`, `skipped`, `neutral`, `timed_out`, `action_required`, ...;
a commit status is `success` or `failure`).

**Server:** `check_run` / `completed`, or `check_run` / `created` for a
run created already finished; `status` with a state other than `pending`
(`error` counts as `failure`). A check run listing PRs gives one event per
PR; one listing none (as from a fork), and every commit status, goes to
the watched PRs whose head is that commit. The same completion of a check
run is passed on once, even if GitHub sends it twice; a re-run is a new
check run, and an App completing a run again with another conclusion is
sent again. A commit status is sent each time it's set.

**Local mode:** a check on the PR's head commit that is finished now and
wasn't at the last poll, or has another conclusion than it had. After a
push every finished check on the new head counts. A commit status set
again is sent again if a poll sees it pending in between, or finished with
a newer time.

### `check.failed`

The same check finished and failed. Sent just after its
`check.completed`, with the same `data`.

`data`: as `check.completed`, with `conclusion` `failure`, `timed_out`,
`action_required` or `startup_failure`.

**Server:** the same webhooks as `check.completed`, for those
conclusions; a commit status in state `failure` or `error`.

**Local mode:** the same changes as `check.completed`, for those
conclusions.

### `workflow.completed`

A GitHub Actions workflow run finished.

`data`: `head_sha`, `run_id`, `workflow` (its name), `conclusion`.

**Server:** `workflow_run` / `completed`, one per PR the run lists (or
matched by head commit, like a check run), with GitHub's conclusion.

**Local mode:** every check run of one workflow run on the head commit is
finished, and wasn't at the last poll. The conclusion is worked out from
the jobs: `failure` if any failed, else `cancelled` if any was cancelled,
else `success`. A job that GitHub hasn't created yet (one that waits on
another) isn't counted, so a workflow can be reported finished early.

## The watch itself

These are always delivered, whatever a subscription's `kinds` says. Each
`watch.*` event is its subscription's last; `data.reason` says why.

### `watch.ended`

The PR was merged or closed, so this watch is over. Sent after the
`pr.merged` or `pr.closed`.

`data`: `reason` (`merged`, `closed`).

**Server:** with every `pr.merged` or `pr.closed`, to each subscription
on that PR (not to repository-wide ones), even while the repo is
throttled.

**Local mode:** with `pr.merged` or `pr.closed`, or on the first poll of
a PR that has already ended.

### `watch.expired`

Nobody read the inbox for the subscription's `ttl_seconds` (7 days by
default).

`data`: `reason` (`unread`).

**Server:** when the subscription's time is up and its inbox hasn't been
read, or held open, since.

**Local mode:** Not sent. A local watch lasts until its PR ends or it's
unwatched.

### `watch.unverified`

A subscription on a private repository lost its access check.

`data`: `reason`: `not_verified` (not renewed before `verified_until`),
or `access_denied` (renewed with a GitHub token that can no longer read
the repo).

**Server:** when `verified_until` passes, or on a `verify` call answered
`403 repo_access_denied`.

**Local mode:** Not sent.

### `watch.revoked`

The App can no longer see the repository.

`data`: `reason`: `uninstalled`, `suspended` (the installation was
deleted or suspended), or `removed` (the repo was taken out of the
installation).

**Server:** `installation` / `deleted` or `suspend`, or
`installation_repositories` / `removed`, to every subscription on the
affected repos, repository-wide ones included.

**Local mode:** Not sent. The CLI goes back to polling a PR the server
revoked.

### `repo.throttled`

The repository is sending more webhooks than the server takes (600 an
hour, with bursts of 200). Until it recovers, its webhooks are dropped,
except that a merge or close still ends PR subscriptions with `pr.merged`
or `pr.closed` and `watch.ended`. Meanwhile ask GitHub directly.

`data`: `until` (time).

**Server:** on the first webhook over the limit, once to each inbox with
a subscription on the repo.

**Local mode:** Not sent.

### `repo.unthrottled`

The throttle is over.

`data`: `dropped` (how many webhooks were dropped).

**Server:** once `until` has passed, to each inbox with a subscription on
the repo.

**Local mode:** Not sent.

`repo.*` kinds reach every inbox whatever the subscription's `kinds`,
but the CLI's own `--kinds` filter lets only `watch.*` through, so
`watcheroni wait --kinds check.*` doesn't print them.

PROTOCOL.md also describes `inbox.gap`, for a reader whose position
fell behind the oldest event kept. The server doesn't send it yet: an
inbox keeps its last 1,000 events, and older ones are dropped without
notice.

## Not tracked

**Webhooks the App gets and drops.** Anything not listed above, notably:

- `pull_request`: `edited` (title or body), `labeled`, `unlabeled`,
  `assigned`, `review_request_removed`, `auto_merge_enabled`,
  `enqueued`, `locked` and the rest;
- `pull_request_review` / `edited`; `pull_request_review_comment` and
  `issue_comment` `edited` and `deleted`;
- `issues` actions other than `opened`, `closed`, `reopened` and
  `labeled`;
- `check_run` `created` (unless already finished), `rerequested` and
  `requested_action`; `status` `pending`; `workflow_run` `requested` and
  `in_progress`; `check_suite`, which Apps registered before it was
  dropped may still send.

Local mode doesn't see edits or deletions either, nor labels, assignees
or titles.

**Webhooks that never arrive.** GitHub doesn't retry a failed delivery.
Every 10 minutes the server's cron job
(`packages/server/src/control.ts`) asks GitHub to redeliver deliveries
that failed (no answer, `429` or `5xx`); a redelivery keeps its
ID, so it's never sent twice. GitHub keeps deliveries for 3 days, so a
longer outage loses events. Bodies over 2 MB are refused and not
redelivered. Events the server couldn't hand to an inbox for 24 hours
are dropped.

**What the App can't see.** Its permissions are read-only: metadata,
pull requests, issues, checks, commit statuses and actions
(`packages/server/selfhost/manifest.ts`). Without contents it gets no
`push` (so nothing about branches without a PR), branch or tag creation
and deletion, or releases. It doesn't subscribe to `repository`, so a
repository deleted, renamed or transferred sends nothing. Nor does it
see deployments, discussions or merge queues.

**State with no event.** Whether the PR can be merged (conflicts,
required checks, branch protection), whether all of a commit's checks
are done, and whether the PR has the approvals it needs are states, not
things that happen. Ask GitHub when an event makes them worth knowing:

```
gh pr checks 123 -R octo/widgets                          # every check's state
gh pr view 123 -R octo/widgets --json mergeable,mergeStateStatus,reviewDecision
```
