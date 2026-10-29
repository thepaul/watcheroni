# Releasing

Two packages go to npm, always with the same version:

- **`watcheroni`** (`packages/cli`): the CLI, one bundled file with no
  runtime dependencies.
- **`@watcheroni/protocol`** (`packages/protocol`): the protocol's types
  and constants. Its `package.json` points at the TypeScript source, for
  the workspace, and is private; `npm run build` there makes the real
  package in `packages/protocol/dist` (JS, `.d.ts`, and a `package.json`
  pointing at them), and that directory is what gets published.

The Claude Code plugin (`plugin/`) isn't on npm either; people install
it from this repository's `main` branch through the marketplace in
`.claude-plugin/marketplace.json`. It carries the same version too, in
`plugin/.claude-plugin/plugin.json`, and runs the CLI as
`npx watcheroni@^X.Y.Z`, so a plugin only ever runs a CLI it was released
with (or a later patch). Claude Code updates an installed plugin only
when that version changes, so a change to `plugin/` reaches users with
the next release.

The server (`packages/server`) isn't published, but it carries the same
version, which `/v1/meta` reports as `server: "watcheroni/X.Y.Z"`. A
server deployed from `main` between releases reports the last release.

Releases are published by `.github/workflows/release.yml` when a `vX.Y.Z`
tag is pushed: it runs the CI checks, checks the tagged commit is on
`main` and the tag matches all three `package.json` versions and the
plugin's, builds, and publishes both packages with
provenance. Nobody publishes from their own machine.

## Making a release

```
git switch main && git pull
npm version 0.2.0 --workspaces --no-git-tag-version   # all three packages and the lockfile
node scripts/plugin-version.mjs                        # the plugin, from the CLI's version
git commit -am "Release 0.2.0"
git tag v0.2.0
git push origin main v0.2.0
```

Then watch the Release workflow in the repository's Actions tab. When
it's done:

```
npx watcheroni@latest --version
npm view @watcheroni/protocol version types
```

If a run fails after publishing one package, fix the cause and re-run
it: a version that's already on npm is skipped. A broken release can't
be overwritten; publish a new patch version, and
`npm deprecate watcheroni@0.2.0 "..."` the broken one.

Before 1.0, a breaking change to the CLI's output or flags, or to the
protocol types, bumps the minor version.

The plugin is live as soon as the release commit is on `main`, perhaps a
few minutes before npm has the CLI it asks for. Until then a plugin that
was just updated fails to start the new CLI through npx (an older
installed one keeps working); it's fixed once the publish finishes.
If the release workflow fails, fix it quickly, or revert the plugin's
version on `main`.

## Publishing credentials

The workflow publishes with npm trusted publishing (OIDC) when it's set up
for both packages, and otherwise with the `NPM_TOKEN` secret of the `npm`
GitHub environment, which the publish job runs in.
The packages must exist on npm before trusted publishing can be set up,
so the first release uses a token:

1. On npmjs.com, create a granular access token with read and write
   access to all packages (or the `watcheroni` scope), "bypass two-factor
   authentication" ticked, and a short expiry (a week).
2. In the repository's Settings, Environments, create the `npm`
   environment (if a release run hasn't already). Under "Deployment
   branches and tags", choose "Selected branches and tags" and add the
   tag rule `v*`, so only release tags can use it.
3. Store the token as a secret of that environment, not of the
   repository:

   ```
   gh secret set NPM_TOKEN --env npm -R thepaul/watcheroni
   ```
4. Release as above.
5. Then, for each of `watcheroni` and `@watcheroni/protocol`, on its
   npmjs.com settings page add a trusted publisher: GitHub Actions,
   repository `thepaul/watcheroni`, workflow `release.yml`, environment
   `npm`. Delete the `NPM_TOKEN` environment secret
   (`gh secret delete NPM_TOKEN --env npm -R thepaul/watcheroni`) and
   revoke the token, and set each package to "require two-factor
   authentication and disallow tokens".

Optionally:

- Add a required reviewer to the `npm` environment, so each release
  needs a second approval.
- Add a tag ruleset (Settings, Rules, Rulesets, "New tag ruleset")
  targeting `v*` that restricts creation, updates and deletion to
  maintainers, so a release tag can't be pushed, moved or deleted by
  anyone else.
