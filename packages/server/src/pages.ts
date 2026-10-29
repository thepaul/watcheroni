// The server's two HTML pages: the landing page at GET / and the App's
// Setup URL at GET /github/setup. Inline HTML and CSS, light and dark from
// the browser's setting, no scripts, cookies or anything from another
// host (the Content-Security-Policy says so). The install URL comes from
// the caller, so these don't decide which App they point at.

const REPO_URL = "https://github.com/thepaul/watcheroni";
const PROTOCOL_URL = `${REPO_URL}/blob/main/PROTOCOL.md`;
const SELF_HOSTING_URL = `${REPO_URL}/blob/main/DESIGN.md#self-hosting`;
const PLUGIN_URL = `${REPO_URL}/tree/main/plugin`;
const CLI_URL = `${REPO_URL}/tree/main/packages/cli#readme`;
const RECIPES_URL = `${REPO_URL}/blob/main/docs/recipes.md`;

// What `watcheroni wait` prints (packages/cli/src/format.ts), as in the
// CLI's README.
const WAIT_EXAMPLE = `$ npx watcheroni wait
octo/widgets#123: 2 new events
- check.failed: "test (ubuntu-latest)" (failure) on 4f9c2e1
  gh run view 18342210911 -R octo/widgets --log-failed
- review.submitted by mona: changes_requested
  gh api repos/octo/widgets/pulls/123/reviews/3374120415 --jq '.state, .body'

octo/widgets#123 is still open. Run \`watcheroni wait\` again to keep watching.`;

// GET /. The install URL is undefined on a server that has no App yet.
export function landingPage(installUrl: string | undefined): Response {
  return page(
    "watcheroni: wake up when your pull request needs you",
    `<header>
<h1>watcheroni</h1>
<p class="lead">Wait for what happens to your GitHub pull requests: CI finishing or failing, reviews, comments, pushes, merges. Built for scripts and coding agents that open a PR and then need to know when there's something to do about it, without polling GitHub in a loop.</p>
</header>
<pre><code>${escape(WAIT_EXAMPLE)}</code></pre>
<p>Events with more to read come with the command that fetches it. <code>wait</code> exits once there's news, so run it again to keep watching.</p>

<h2>Start</h2>
<ol class="steps">
<li>${installUrl ? `<a class="button" href="${escape(installUrl)}">Install the GitHub App</a>` : "Install the GitHub App"} on the repositories you want to watch.</li>
<li>Sign in from your computer. It shows a code to enter at github.com:
<pre><code>npx watcheroni login</code></pre></li>
<li>In a checkout whose branch has an open pull request (or name one, like <code>octo/widgets#123</code>):
<pre><code>npx watcheroni wait</code></pre></li>
</ol>
<p>It needs Node.js 22 or later. No App? The CLI also works on its own, polling GitHub with your <code>gh</code> login; see <a href="${CLI_URL}">its README</a>.</p>

<h2>Use it your way</h2>
<ul>
<li><code>watcheroni stream</code> prints each event as a line of JSON, and <code>watcheroni exec -- <var>command</var></code> runs a command for each one: <a href="${RECIPES_URL}">recipes</a> for desktop notifications, Slack and more.</li>
<li>A coding agent can run <code>watcheroni wait</code> in the background and read what it prints when it exits. For Claude Code there's a <a href="${PLUGIN_URL}">plugin</a> that teaches it the commands.</li>
<li>Or skip the CLI: <a href="${PROTOCOL_URL}">the protocol</a> is plain HTTP and WebSockets.</li>
</ul>

<h2>What the server keeps</h2>
<ul>
<li>The App's permissions are all read-only: metadata, pull requests, issues, checks, commit statuses and actions. No code, no administration, no write access of any kind.</li>
<li>Your GitHub token is only used for checks: who you are when you sign in, and what you can read when you watch a private repository (checked again weekly). It is never stored.</li>
<li>Webhook payloads are never stored, only the few facts each event needs: what happened, on which pull request, by whom, and links to the details on GitHub.</li>
<li>Your watcheroni API key is stored only as a hash.</li>
</ul>

<h2>More</h2>
<ul class="links">
<li><a href="${REPO_URL}">Source code</a>, MIT licensed</li>
<li><a href="${PROTOCOL_URL}">The protocol</a>, for writing your own client</li>
<li><a href="${SELF_HOSTING_URL}">Running your own server</a> on Cloudflare's free plan</li>
</ul>`,
  );
}

// GET /github/setup: the App's "Setup URL", where GitHub sends people
// after they install it or change its repos. GitHub passes
// installation_id and setup_action (install, update, or request when an
// organization's owner has to approve). Nothing from the query is echoed
// into the page.
export function setupPage(url: URL): Response {
  const requested = url.searchParams.get("setup_action") === "request";
  const heading = requested ? "Installation requested" : "watcheroni is installed";
  const lead = requested
    ? "Your request has gone to the organization's owners. Once one of them approves it, GitHub will send watcheroni events from those repositories."
    : "GitHub will now send watcheroni events from the repositories you chose.";
  return page(
    "watcheroni",
    `<header>
<h1>${heading}</h1>
<p class="lead">${lead}</p>
</header>
<ol class="steps">
<li>Sign in from your computer:
<pre><code>npx watcheroni login</code></pre></li>
<li>Then, in a checkout whose branch has an open pull request:
<pre><code>npx watcheroni wait</code></pre></li>
</ol>
<p><a href="/">How watcheroni works</a></p>`,
  );
}

function page(title: string, body: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escape(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cache-control": "public, max-age=300",
    },
  });
}

const STYLE = `
  :root { color-scheme: light dark; --fg: #1f2328; --bg: #fff; --muted: #59636e; --code: #f6f8fa; --border: #d1d9e0; --accent: #1f6feb; --on-accent: #fff; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e6edf3; --bg: #0d1117; --muted: #9198a1; --code: #161b22; --border: #3d444d; --accent: #388bfd; --on-accent: #0d1117; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-text-size-adjust: 100%; }
  main { max-width: 44rem; margin: 0 auto; padding: 2.5rem 16px 4rem; }
  h1 { font-size: 2rem; margin: 0 0 .5rem; letter-spacing: -.01em; }
  h2 { font-size: 1.2rem; margin: 2.5rem 0 .75rem; padding-top: 1.5rem; border-top: 1px solid var(--border); }
  .lead { font-size: 1.1rem; margin-top: 0; }
  p, li { color: var(--muted); }
  li { margin: .5rem 0; }
  ul, ol { padding-left: 1.4rem; }
  .steps > li { margin: 1rem 0; }
  .steps > li::marker { color: var(--fg); font-weight: 600; }
  pre { background: var(--code); border: 1px solid var(--border); padding: .75rem 1rem; border-radius: 6px; overflow-x: auto; color: var(--fg); font-size: .85rem; line-height: 1.45; }
  code { font: .9em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--fg); }
  pre code { font-size: inherit; }
  a { color: var(--accent); }
  a.button { display: inline-block; background: var(--accent); color: var(--on-accent); padding: .45rem .9rem; border-radius: 6px; font-weight: 600; text-decoration: none; }
  a.button:hover, a.button:focus-visible { filter: brightness(1.1); }
`;

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
