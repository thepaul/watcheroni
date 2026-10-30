# watcheroni plugin for Claude Code

A convenience for using the [watcheroni CLI](../packages/cli/README.md)
from Claude Code. Any agent that can run a background command can use the
CLI directly; this plugin just saves a session from having to learn it.

- **`watch-pr` skill:** tells Claude what `watcheroni wait` and the other
  commands do, how to run them in the background, and how to read their
  output and exit codes. What to do about the events is up to you and
  Claude.
- **SessionStart hook:** when a session is resumed or compacted and its
  inbox still watches PRs, it tells Claude which ones, and that its
  background `wait` may have stopped.
- **`bin/watcheroni`:** finds the CLI (see the skill's "Installing").

## Install

In a terminal:

```
claude plugin marketplace add thepaul/watcheroni
claude plugin install watcheroni@watcheroni
```

(or `/plugin marketplace add thepaul/watcheroni` and
`/plugin install watcheroni@watcheroni` inside Claude Code), then start a
new session. Then ask Claude to "watch PR octo/widgets#123", or to watch
the PRs it opens, and say what it should do when something happens.

The plugin needs Node.js 22 or later. It runs the
[watcheroni CLI](../packages/cli/README.md) through `npx` unless you
install it, which saves a registry check on each run:

```
npm install -g watcheroni@^0.3.0
```

Plugin version X.Y.Z goes with CLI X.Y.Z; through npx it uses the latest
compatible CLI (`watcheroni@^X.Y.Z`). `claude plugin update watcheroni@watcheroni`
updates the plugin (restart Claude Code after).

Then either:

- **Sign in** to the watcheroni server, after installing the
  [GitHub App](https://github.com/apps/watcheroni/installations/new) on
  your repositories: `npx watcheroni login`. Events arrive within seconds
  of GitHub sending them.
- **Or don't:** without signing in, the CLI polls GitHub every 2 minutes
  with your `gh` login (`gh auth login`, or `GH_TOKEN` / `GITHUB_TOKEN`).

### From a clone

To try changes to the plugin or the CLI:

```
git clone https://github.com/thepaul/watcheroni && cd watcheroni
npm install && npm run build -w watcheroni
claude plugin marketplace add "$PWD"
claude plugin install watcheroni@watcheroni
```

Claude Code runs an installed plugin from a copy in its plugin cache, where
`bin/watcheroni` can't find the clone's build, so put that build on PATH
(`npm install -g ./packages/cli` links it), or set `WATCHERONI_CLI` to
`packages/cli/dist/watcheroni.mjs`. After editing `plugin/`, run
`claude plugin marketplace update watcheroni` and
`claude plugin update watcheroni@watcheroni` (the cache is keyed by the
plugin's version, so without a version bump, uninstall and install it
again instead).

Or skip the install and load it for one session with
`claude --plugin-dir plugin`, which uses the clone's build directly.
