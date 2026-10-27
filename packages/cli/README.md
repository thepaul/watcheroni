# watcheroni (CLI, local mode)

Roadmap step 2 from [DESIGN.md](../../DESIGN.md): the `watcheroni`
command, polling GitHub directly. There's no server yet, so it uses your
`gh` login (or `GH_TOKEN` / `GITHUB_TOKEN`), and the token stays on this
machine. Its output, event kinds and exit codes are the ones the server
version will have, so scripts and agents written against it keep working.

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
npm test                 # Vitest, no network
npm run dev -- wait octo/widgets#123
npm run build            # dist/watcheroni.mjs, one file, no dependencies
```
