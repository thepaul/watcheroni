# watcheroni

Wait for, stream, or act on what happens to your GitHub pull requests:
CI finishing or failing, reviews, comments, pushes, merges. It's built
for scripts and coding agents that open a PR and then need to know when
there's something to do about it, without polling GitHub in a loop.

```
$ npx watcheroni wait
octo/widgets#123: 2 new events
- check.failed: "test (ubuntu-latest)" (failure) on 4f9c2e1
  gh run view 18342210911 -R octo/widgets --log-failed
- review.submitted by mona: changes_requested
  gh api repos/octo/widgets/pulls/123/reviews/3374120415 --jq '.state, .body'

octo/widgets#123 is still open. Run `watcheroni wait` again to keep watching.
```

Requires Node.js 22 or later.

## Getting started

1. **Install the GitHub App** on the repositories you want to watch:
   <https://github.com/apps/watcheroni/installations/new>. It asks for
   read-only access to pull requests, checks and their metadata, and
   sends their webhooks to the watcheroni server at
   <https://watcheroni.dev>.
2. **Sign in** from your machine. This runs GitHub's device flow (a code
   to enter at github.com) and saves an API key for the server:

   ```
   npx watcheroni login
   ```
3. **Wait** for something to happen to the PR for your current branch
   (or name one: `npx watcheroni wait octo/widgets#123`):

   ```
   npx watcheroni wait
   ```

   It exits once there's news, printing each event with the command that
   fetches its details, so run it again to keep watching.

To skip npx's registry check on every run, install it:
`npm install -g watcheroni`.

**No App, no server?** Everything also works without signing in: the CLI
then polls GitHub itself every 2 minutes with your `gh` login (or
`GH_TOKEN` / `GITHUB_TOKEN`), and that token never leaves your machine.
See "Local mode" below.

## Claude Code

The watcheroni plugin for Claude Code has a session keep watching the PRs
it opens or pushes to, in the background, and deal with failing checks
and review feedback as they arrive:

```
claude plugin marketplace add thepaul/watcheroni
claude plugin install watcheroni@watcheroni
```

It runs this CLI through npx unless it's installed. See
[the plugin's README](https://github.com/thepaul/watcheroni/tree/main/plugin)
for what it does and doesn't do.

## Commands

```
watcheroni wait   [target...] [--timeout 1h] [--settle 20s] [--format text|json]
watcheroni stream [target...]
watcheroni exec   [target...] [--on kinds] [--batch] -- command [args...]
watcheroni watch  [target...]
watcheroni unwatch <target...>
watcheroni ls
```

Targets are `owner/repo#123` or PR URLs. With none, it's the open PR for
the current git branch, found through the checkout's GitHub remotes.
`owner/repo` watches a whole repository, in server mode only (see
below).

- **`wait`** polls (every 2 minutes; `--interval`) until something
  happens, waits `--settle` for related events, prints them with the
  command that fetches each one's content, and exits. Exit codes: `0`
  events, `2` timeout, `3` every watched PR has ended, `4` no GitHub
  credentials, `1` other errors.
- **`stream`** prints each event as a JSON line until killed.
- **`exec`** runs a command per event, with the event as JSON on stdin and
  `WATCHERONI_KIND`, `_REPO`, `_PR`, `_URL` and `_EVENT_ID` in its
  environment. An event is acknowledged only when the command exits 0.
  `--batch` runs it once per settled batch, with a JSON array on stdin.

## Recipes

Desktop and phone notifications, Slack, only CI failures, and running
`exec` as a background service:
[docs/recipes.md](https://github.com/thepaul/watcheroni/blob/main/docs/recipes.md).

## Server mode

Sign in, which runs GitHub's device flow and saves an API key in
`~/.config/watcheroni/credentials.json` (mode 0600). It opens the browser
at GitHub's code page when you're at this machine's own terminal; over
SSH, or with `WATCHERONI_NO_BROWSER` set, it just prints the address:

```
watcheroni login                      # https://watcheroni.dev
WATCHERONI_SERVER=https://... watcheroni login
```

Once you're signed in to the default server, the CLI uses it. To use
another, name it in `WATCHERONI_SERVER` or `~/.config/watcheroni/config.json`
(`{"server": "https://..."}`). For CI, `WATCHERONI_API_KEY` stands in for
the credentials file. The environment wins, and `WATCHERONI_SERVER=`
(empty) forces local mode. `WATCHERONI_CONFIG_DIR` moves both files, and
`WATCHERONI_CREDENTIALS` moves just the credentials. `watcheroni logout`
revokes the key and forgets it.

`wait`, `stream` and `exec` then:

1. Create the inbox on the server (`PUT /v1/inboxes/{name}`), which also
   checks the key. A rejected key exits 4.
2. Read it over a WebSocket (subprotocol `watcheroni.v1`: `hello` with the
   last seq received, `ready`, `events`, `ack`, and a `ping` every 30 s).
   If no socket can be opened but HTTP works, they long-poll
   `GET /v1/inboxes/{name}/events?after=&wait=300` instead. Lost
   connections are retried with backoff (1 s doubling to 60 s, with
   jitter); close code 4001 exits 4, 4004 exits 1, and 4029 switches to
   long-polling. Events seen before are dropped by `id`.
3. Acknowledge on the server as local mode does: `wait` once it has
   printed, `stream` after each line, `exec` only after the command exits
   0. A new process starts from the server's acknowledged position, so a
   killed `wait` loses nothing.

Targets: each PR named on the command line (or the current branch's PR)
is subscribed on the server (`POST /v1/inboxes/{name}/subscriptions`),
which then feeds the inbox from GitHub's webhooks, and this machine stops
polling it. The request carries no GitHub token unless the server answers
`github_token_required`, meaning the repo is private; then it's sent again
with the GitHub token `watcheroni login` saved, renewed first through the
server's refresh proxy if it has expired (and saved again). The server
uses the token for one check and forgets it.

A PR the server won't watch stays polled from this machine, as in local
mode, with its events merged with the server inbox's: when the watcheroni
App isn't installed on the repo (stderr says where to install it), when
there's no usable GitHub token for a private repo (`WATCHERONI_API_KEY`
alone has none), or when the server refuses for another reason. Such a PR
is offered to the server again at most hourly. When the server ends a
subscription, a `watch.ended` or `watch.expired` stops the watch here too;
after a `watch.revoked` (the App uninstalled or the repo removed from it)
the PR goes back to being polled from this machine.

A whole repository (`owner/repo`) is watched by the server or not at all,
since local mode would have to poll every PR in it. It needs `--kinds`,
which the subscription carries (and which, as always, also filters what
`wait` prints), and may narrow to PRs against one branch (`--base main`)
or opened by one user (`--author alice`):

```
watcheroni wait octo/widgets --kinds pr.opened --base main
watcheroni wait octo/widgets --kinds check.failed --author alice
```

If the server won't take it (the App isn't installed, say) or can't be
reached, the command exits 1. Once subscribed it's remembered in the
inbox (`ls` lists it, `unwatch octo/widgets` ends every whole-repository
watch on it, on the server too), and while it lasts `wait` never exits 3:
it exits 0 on events and 2 on timeout. A `watch.*` event from the server
(`watch.expired` after a week unread, `watch.revoked`) ends it; name it
again to start over.

Because an inbox may be fed by subscriptions made elsewhere, which can't
be listed yet, `wait` with no PR watched here reads the inbox until
`--timeout` instead of exiting 3. It exits 3 when the PRs it was watching
have all ended.

**Fallback.** If the server can't be reached, the CLI says so on stderr
and polls the named PRs from this machine, subscribed or not, while it
keeps trying to reconnect. A `wait` with nothing to poll locally exits 1 instead of
waiting on a server that's down; `stream` and `exec` keep retrying.

## Local mode

Each poll is one GraphQL query per PR (cost: 1 point of GitHub's 5,000 an
hour). The CLI compares it with the last snapshot and turns the
difference into events (`src/diff.ts`). The first poll of a PR is the
starting point: what was already true then isn't reported, as with a
server subscription. A PR that has already ended is reported as
`watch.ended` straight away.

State lives in `~/.local/state/watcheroni/inboxes/<inbox>.json`
(`$WATCHERONI_STATE_DIR` to move it). Events are saved before they're
printed and removed only once acknowledged, so a `wait` that gets killed
loses nothing: the next one prints the same events. One process at a time
uses an inbox. The inbox is `--inbox`, or `$WATCHERONI_INBOX`, or
`cc-$CLAUDE_CODE_SESSION_ID` inside Claude Code, or `default`.

What local mode can't see that the server will: events between polls
that undo each other (a thread resolved and then unresolved within one
interval), more than the last 100 reviews, threads or comments, and
repository-wide targets.

## More

How it's built, and the API other clients can use:
[DESIGN.md](https://github.com/thepaul/watcheroni/blob/main/DESIGN.md),
[PROTOCOL.md](https://github.com/thepaul/watcheroni/blob/main/PROTOCOL.md)
(and its types, [`@watcheroni/protocol`](https://www.npmjs.com/package/@watcheroni/protocol)).
Issues: <https://github.com/thepaul/watcheroni/issues>. MIT licensed.

## Develop

From a clone of the repository, in `packages/cli`:

```
npm test                 # Vitest, no network; server mode runs against a fake server (test/fake-server.ts)
npm run dev -- wait octo/widgets#123
npm run build            # dist/watcheroni.mjs, one file, no dependencies
```
