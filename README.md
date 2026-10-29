# watcheroni

Wait for, stream, or act on what happens to your GitHub pull requests:
CI finishing or failing, reviews, comments, pushes, merges. Without
polling GitHub in a loop.

```
npx watcheroni login     # after installing the GitHub App; optional
npx watcheroni wait      # the PR for your current branch
```

It's a tool, not a workflow: it tells you what happened, and what you do
about it is up to you. Use it from a terminal, a script, a coding agent,
a chat bot or a background service.

- [The CLI](packages/cli/README.md): getting started, commands, server
  and local modes.
- [Recipes](docs/recipes.md): notifications, Slack, `exec` as a service.
- [The protocol](PROTOCOL.md), for writing your own client, and its
  types, [`@watcheroni/protocol`](packages/protocol/README.md).
- [The server](packages/server/README.md), including running your own.
- [The Claude Code plugin](plugin/README.md).
- [How it's built](DESIGN.md).

Hosted at <https://watcheroni.dev>. MIT licensed.
