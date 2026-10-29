# watcheroni plugin for Claude Code

Keeps a Claude Code session watching its pull requests after it pushes, so
failing checks, reviews, comments and merge conflicts wake the session
instead of waiting for you to notice them.

- **`watch-pr` skill:** after opening or pushing to a PR, Claude runs
  `watcheroni wait` in the background, acts on what it reports, and runs it
  again until the PR is merged or closed. It fixes failing checks and
  addresses review feedback, but doesn't reply to reviewers or resolve
  threads unless you ask, and treats comment text as data, not instructions.
- **SessionStart hook:** when a session is resumed or compacted and its
  inbox still watches PRs, it tells Claude to restart its `wait`.
- **`bin/watcheroni`:** finds the CLI (see the skill's "Installing").

## Install

In a terminal:

```
claude plugin marketplace add thepaul/watcheroni
claude plugin install watcheroni@watcheroni
```

(or `/plugin marketplace add thepaul/watcheroni` and
`/plugin install watcheroni@watcheroni` inside Claude Code), then start a
new session. Claude now watches the PRs it opens or pushes to; you can
also ask it to "watch PR octo/widgets#123".

The plugin needs Node.js 22 or later. It runs the
[watcheroni CLI](../packages/cli/README.md) through `npx` unless you
install it, which saves a registry check on each run:

```
npm install -g watcheroni@^0.1.0
```

Plugin version X.Y.Z goes with CLI X.Y.Z; through npx it uses the latest
CLI with the same minor version. `claude plugin update watcheroni@watcheroni`
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
