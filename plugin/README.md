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

```
claude plugin marketplace add <path to a clone, or owner/repo>
claude plugin install watcheroni@watcheroni
```

Until the CLI is on npm, build it in the clone first:
`npm install && npm run build -w watcheroni`. Installed from a local
clone, the plugin uses that build. It needs a GitHub login (`gh auth login`).
