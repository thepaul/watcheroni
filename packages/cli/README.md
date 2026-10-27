# watcheroni (CLI)

The `watcheroni` command from [DESIGN.md](../../DESIGN.md). With a
watcheroni server configured it reads an inbox on the server (server
mode); without one it polls GitHub directly with your `gh` login (or
`GH_TOKEN` / `GITHUB_TOKEN`), and the token stays on this machine (local
mode). Output, event kinds and exit codes are the same in both, so
scripts and agents work with either.

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

## Server mode

Set the server and an API key:

```
export WATCHERONI_SERVER=https://watcheroni-proto.example.workers.dev
export WATCHERONI_API_KEY=...
```

or put them in `~/.config/watcheroni/config.json`
(`{"server": "https://..."}`) and `~/.config/watcheroni/credentials.json`
(`{"servers": {"https://...": {"api_key": "..."}}}`; keep it mode 0600). The
environment wins; `WATCHERONI_SERVER=` (empty) forces local mode. There's
no `watcheroni login` yet: against the prototype server, the API key is
its shared `PROTO_TOKEN`.

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

Targets: the prototype server has no subscriptions yet, so PRs named on
the command line (or the current branch's PR) are still polled from this
machine, as in local mode, and their events are merged with the server
inbox's. `subscribe()` in `src/server.ts` is where server subscriptions
go: a target it subscribes is left to the server, and one it can't (the
App isn't installed, say) stays polled locally.

Because an inbox may be fed by subscriptions made elsewhere, which can't
be listed yet, `wait` with no PR watched here reads the inbox until
`--timeout` instead of exiting 3. It exits 3 when the PRs it was watching
have all ended.

**Fallback.** If the server can't be reached, the CLI says so on stderr
and polls the named PRs from this machine while it keeps trying to
reconnect. A `wait` with nothing to poll locally exits 1 instead of
waiting on a server that's down; `stream` and `exec` keep retrying.

## How local mode works

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

## Develop

```
npm test                 # Vitest, no network; server mode runs against a fake server (test/fake-server.ts)
npm run dev -- wait octo/widgets#123
npm run build            # dist/watcheroni.mjs, one file, no dependencies
```
