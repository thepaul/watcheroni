# PR watching for Claude Code sessions: notes and design

Written 2026-10-26, from a design discussion in a Claude Code session in the
LightCam superproject. Nothing here has been built yet.

## The problem

Claude Code's Auto-Fix (the desktop app watching a session's PR and waking
the session on CI failures, merge conflicts and review comments) is too
unreliable to depend on. Something like half the time the session is never
told about a new review, and a human has to check the PR and nudge the
session by hand.

What a replacement needs:

1. **Easy for sessions to use.** A session subscribes to its PR, gets on
   with other work, and is woken when something on the PR changes.
2. **Doesn't need to be instant.** A delay of a few minutes is fine, so
   plain polling is acceptable.
3. **Webhooks are an option, not a requirement** (see the hosted design
   below).

## What we found

### Ways to get a notice into a Claude Code session

- **Background Bash (`run_in_background`).** The command runs detached and
  keeps running across turns. When it exits, Claude Code re-invokes the
  session with its output. Its documentation states no time limit. Delivery
  goes through the session's own harness, with no relay in between. **This
  is the best native mechanism for this.**
- **The Monitor tool.** Each line a background script prints becomes a
  notification in the session, and it can also open a WebSocket (`ws:`
  source), where each message becomes a notification. But every monitor is
  killed after at most 30 minutes and must be re-armed. For a long watch
  that means a wake-up every half hour, and a session that forgets to
  re-arm goes quiet.
- **MCP "channels"** (an MCP server pushing events into a session). As far
  as we know it's a research preview, enabled by a flag when launching the
  CLI. It's unclear whether Desktop app sessions can use it. Not checked in
  depth.
- **The app's built-in notification queue** (`ReadNotifications`: "GitHub
  activity on subscribed PRs, scheduled triggers, messages from other
  Claude sessions"). This is most likely the same pipeline Auto-Fix uses,
  so it's the thing being replaced.
- **Headless relay: rejected.** A daemon runs
  `claude -p --model haiku` with only the `SendMessage` tool, to message
  the target session. LightCam's `resourcecontrol` used this. It breaks
  easily (and was broken at the time of writing), so we don't want it.

### The `babysit-pr` plugin

`babysit-pr` (`github.com/vaibhavmalik/babysit-pr`) is a third-party plugin
in the claude.ai plugin directory, marked as not reviewed. It is not a
Claude Code feature. It is just a `SKILL.md` that has the session itself:

- check CI every 30 seconds in the foreground, for at most 15 minutes
- then gather the review comments, fix or defer each one, push, and reply
- go around again, at most 5 times, then stop.

It ties the session up while it waits, and stops for good once the PR looks
clean, so a review that arrives later is never seen. It also replies to and
defers comments on its own. It's useful as a reference for what a session
should do once it's woken, but it doesn't help with the waiting.

(The `/babysit-prs` mentioned in the built-in `/loop` skill's description
is only an example name, not a real command.)

### GitHub plans, webhooks and Apps

- **Upgrading to GitHub Enterprise doesn't help.** Every plan already has
  repo, org and GitHub App webhooks. The real obstacle to receiving them is
  that a webhook needs a public URL to deliver to, which a developer laptop
  doesn't have.
- **No cap on installed Apps:** "There is no limit to how many apps you can
  install" (GitHub's Marketplace docs). Nothing we found varies by plan.
- **Owning Apps:** "A user or organization can register up to 100 GitHub
  Apps." This limits how many Apps you can create, not how many a repo can
  use.
- **"Each GitHub App has one webhook"**, covering all its installations. We
  believe repos and orgs separately limit their own hand-made webhooks
  (about 20 per event) and that an App's webhook doesn't count toward that,
  but we couldn't confirm it in GitHub's current docs.
- **API rate limits are what plans change.** An installation token starts
  at 5,000 requests per hour. A third-party page says Enterprise Cloud
  installations get 15,000; GitHub's own docs confirm Enterprise Cloud is
  treated differently, but we didn't confirm the exact number. Webhook
  deliveries don't use this budget.

## Design A: local `pr-wait` (no server)

A command-line tool that blocks until something on a PR changes. Sessions
run it with `run_in_background`.

- **Usage:** `pr-wait <pr-url>...` checks GitHub every ~2 minutes using the
  user's `gh` credentials. GraphQL can cover several PRs in one request. It
  exits as soon as anything changed:
  - new reviews, review comments or PR comments
  - a check failing, or all checks passing
  - a merge conflict appearing
  - the PR being merged or closed

  Its output is a short summary pointing to `gh pr view`, ending with
  "run me again if the PR is still open".
- **A saved cursor, so nothing slips through.** "The last state this
  session was shown" is saved on disk, keyed by session ID
  (`CLAUDE_CODE_SESSION_ID`) and PR. Each run compares GitHub against that
  saved state, not against the moment it started. Changes that happen
  between one run exiting and the session restarting it are reported
  immediately on the next run.
- **App restarts.** A background process probably dies when the app
  restarts the session's process (test this first). If it does, a
  SessionStart hook can tell a resumed session which PRs it was watching,
  so it runs `pr-wait` again.
- **No running service to break:** no daemon, no launchd job, no headless
  Claude. If the tool is broken, the session sees it fail.
- **Session instructions:** "after opening a PR, run `pr-wait <url>` in the
  background, and run it again each time it exits."
- **Cost:** one GraphQL request per poll is roughly 30 rate-limit points an
  hour, out of 5,000.

The same pattern could replace other cross-session messaging, for example
`resourcecontrol wait-inbox` instead of a headless relay.

## Design B: a hosted, general-purpose webhook watcher

Something not tied to any one org: a small hosted service that anyone can
use or run themselves. Clients subscribe to a PR and get events pushed or
long-polled to them.

### How users connect it: a GitHub App, not handed-over tokens

Having clients hand over temporary tokens doesn't work well:

- **Creating a webhook needs admin rights on the repo.** Many people who
  want to watch a PR aren't repo admins. Webhooks created on someone's
  behalf also have to be found and deleted later.
- **The easy token is too powerful.** The token a CLI can get without
  effort, `gh auth token`, is a broad OAuth token for every repo and org
  the user can reach. Nobody should give that to a third-party service.
- **Fine-grained personal tokens have to be created by hand** in GitHub's
  web settings. A tool can't create one for you.

So:

1. **The service is a GitHub App.** A user or org owner installs it on
   chosen repos or a whole org. GitHub then sends those repos' events to
   the App's one webhook URL, with nothing to set up per repo or PR. The
   App only needs read access to metadata, pull requests, checks and
   commit statuses.
2. **Clients sign in with GitHub's OAuth device flow.** The CLI shows "go
   to github.com/login/device and enter ABCD-1234". It gets a token that
   acts as the user but is limited to what the App can do. The service
   uses it to confirm the user can read the repo before allowing a
   subscription; without that check, anyone could watch a private repo's
   events by knowing its name. Then it gives the client the service's own
   revocable key.
3. **Self-hosting.** The code is open; anyone can register their own App
   and deploy their own copy. The hosted copy is the convenient default.

The catch for adoption: installing the App on an organization needs an org
owner.

### Send a pointer, not the content

GitHub's webhook payload includes review and comment text. The service
keeps only the metadata: repo, PR, event type, who did it, the review's
verdict, the check's result, and IDs. Clients fetch the actual content
themselves with their own credentials. This:

- means the service never stores or passes along anyone's private code or
  comments, which lowers how much users must trust it and what the
  operator is liable for
- keeps what it stores small
- means the text reaches an agent the way it normally reads GitHub, not as
  a message pushed in from outside.

### Subscriptions and the event log

- `POST /subscriptions {repo, pr, events: [review, review_comment,
  comment, checks, conflict, closed], ttl}` returns an ID. A subscription
  ends on its own when the PR is merged or closed, or when its time limit
  runs out.
- **Each subscription has its own log** of events in order, with a number
  that only goes up. Clients read with a cursor, which gives:
  - catching up after a disconnect or restart, so nothing is lost
  - at-least-once delivery
  - dropping duplicates by GitHub's delivery ID (`X-GitHub-Delivery`)
- **Every webhook's signature is checked** (`X-Hub-Signature-256`).
- **Webhooks to listen for:**
  - `pull_request` (closed, reopened, new commits pushed)
  - `pull_request_review` and `pull_request_review_comment`
  - `issue_comment`
  - `check_suite`, `check_run` and `status`
- **Things with no webhook, which the service has to work out itself:**
  - **Merge conflicts:** GitHub sends nothing when a PR becomes
    unmergeable. When a `push` arrives on a watched PR's base branch, the
    service asks GitHub whether the PR still merges, using the App's own
    token. GitHub works this out lazily, so the answer may need a second
    request.
  - **"All checks green":** the service has to add up the individual
    check results to know when every check has finished.
- **Missed deliveries:** GitHub doesn't automatically retry a failed
  webhook delivery. The App can list its failed deliveries through GitHub's
  API (`GET /app/hook/deliveries`) and ask for them to be sent again, so
  the service does that on a timer. That covers its own downtime.

### How clients get the events

Store the events once in the log, then offer more than one way to read it:

- **Long-polling over HTTPS (the baseline):**
  `GET /events?cursor=N&wait=300` returns as soon as there are new events,
  or empty after 5 minutes. It works through any proxy or firewall, and it
  maps directly onto a `pr-wait` CLI run as a background command.
- **WebSocket, or a server-sent event stream**, for clients that want a
  live stream: editor extensions, chat bots, and Claude Code's Monitor
  `ws:` source (but Monitor's 30-minute limit makes long-polling better for
  Claude sessions).
- **Later: an MCP server** that pushes events into a session, if Claude
  Code's channels feature matures.

All of these read from the same log with the same cursor, so a client can
switch between them freely.

### Hosting cheaply

- **Cloudflare Workers + Durable Objects** fits best. One Durable Object per
  subscription holds that subscription's log and its waiting connections.
  Workers can hold a request open without paying for the wait, idle
  WebSocket connections are cheap too, and the free tier probably covers a
  small user base.
- **A small VM** (e.g. Fly.io) running one process with SQLite: simple, and
  easy for people to host themselves.
- **AWS Lambda fits poorly:** you pay for every second a long-poll waits,
  and API Gateway cuts HTTP requests off at about 30 seconds.

### What exists already

- **smee.io** and **`gh webhook forward`** relay raw webhooks to a
  developer's machine. smee's channels have no sign-in; `gh webhook
  forward` needs repo admin and is meant for testing.
- **Hookdeck and ngrok** are general-purpose webhook relays.

As far as we know, none of them offer "sign in, subscribe to one PR, get
filtered events with a cursor". That gap is what makes this worth building
as a general tool.

### Open questions

- **Scope:** only PRs, or any repo event with a filter? Start with PRs only;
  the general version gets complicated fast.
- **Abuse limits:** cap subscriptions per user and per installation, and
  expire idle ones.
- **Fallback:** if the service is down, the client polls GitHub directly
  (Design A), as a safety net.
- **The operator's obligations** (privacy policy, terms) for a public
  hosted copy, even with only metadata stored.

## Sources

- [Installing a GitHub App from GitHub Marketplace for your organizations](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-github-marketplace-for-your-organizations)
- [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)
- [Creating webhooks](https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks)
- [Rate limits for GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/rate-limits-for-github-apps)
- [GitProtect: GitHub App](https://helpcenter.gitprotect.io/backup-and-recovery/devops/github/integration/github-app)
  (third party, the source for the Enterprise Cloud rate-limit number)
- [babysit-pr plugin](https://github.com/vaibhavmalik/babysit-pr)
