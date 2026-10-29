# Releasing

Two packages go to npm, always with the same version:

- **`watcheroni`** (`packages/cli`): the CLI, one bundled file with no
  runtime dependencies.
- **`@watcheroni/protocol`** (`packages/protocol`): the protocol's types
  and constants. Its `package.json` points at the TypeScript source, for
  the workspace, and is private; `npm run build` there makes the real
  package in `packages/protocol/dist` (JS, `.d.ts`, and a `package.json`
  pointing at them), and that directory is what gets published.

The server (`packages/server`) isn't published, but it carries the same
version, which `/v1/meta` reports as `server: "watcheroni/X.Y.Z"`. A
server deployed from `main` between releases reports the last release.

Releases are published by `.github/workflows/release.yml` when a `vX.Y.Z`
tag is pushed: it runs the CI checks, checks the tag matches all three
`package.json` versions, builds, and publishes both packages with
provenance. Nobody publishes from their own machine.

## Making a release

```
git switch main && git pull
npm version 0.2.0 --workspaces --no-git-tag-version   # all three packages and the lockfile
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

## Publishing credentials

The workflow publishes with npm trusted publishing (OIDC) when it's set up
for both packages, and otherwise with the `NPM_TOKEN` repository secret.
The packages must exist on npm before trusted publishing can be set up,
so the first release uses a token:

1. On npmjs.com, create a granular access token with read and write
   access to all packages (or the `watcheroni` scope), "bypass two-factor
   authentication" ticked, and a short expiry (a week).
2. Store it as the repository secret `NPM_TOKEN`
   (`gh secret set NPM_TOKEN`).
3. Release as above.
4. Then, for each of `watcheroni` and `@watcheroni/protocol`, on its
   npmjs.com settings page add a trusted publisher: GitHub Actions,
   repository `thepaul/watcheroni`, workflow `release.yml`, environment
   `npm`. Delete the `NPM_TOKEN` secret and revoke the token, and set
   each package to "require two-factor authentication and disallow
   tokens".

The publish job runs in the `npm` GitHub environment, so a required
reviewer can be added there (Settings, Environments) if releases should
need a second approval.
