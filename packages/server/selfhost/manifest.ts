// Registering the GitHub App with GitHub's manifest flow
// (https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest):
// a local page posts the manifest to GitHub, the person clicks "Create
// GitHub App", GitHub sends the browser back to the local server with a
// code, and the code is exchanged for the App's ID, keys and secrets.

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export const GITHUB_WEB_URL = "https://github.com";
export const GITHUB_API_URL = "https://api.github.com";

export interface ManifestOptions {
  // The Worker's URL, e.g. https://watcheroni.example.workers.dev.
  server: string;
  // Prefilled; the person can change it on GitHub's page. App names are
  // unique across GitHub.
  appName: string;
  public: boolean;
}

// DESIGN.md, "GitHub App registration". Device flow can't be turned on
// from a manifest; `selfhost` asks for it afterwards.
export function appManifest(o: ManifestOptions) {
  return {
    name: o.appName,
    url: o.server,
    description: "Sends this server webhooks for the pull requests people watch with watcheroni.",
    hook_attributes: { url: `${o.server}/github/webhook`, active: true },
    setup_url: `${o.server}/github/setup`,
    setup_on_update: true,
    public: o.public,
    request_oauth_on_install: false,
    default_permissions: {
      metadata: "read",
      pull_requests: "read",
      issues: "read",
      checks: "read",
      statuses: "read",
      actions: "read",
    },
    default_events: [
      "pull_request",
      "pull_request_review",
      "pull_request_review_comment",
      "pull_request_review_thread",
      "issue_comment",
      "issues",
      "check_suite",
      "check_run",
      "status",
      "workflow_run",
    ],
  };
}

// With the local callback, which only `createApp` knows.
export type AppManifest = ReturnType<typeof appManifest> & { redirect_url?: string };

// What POST /app-manifests/{code}/conversions answers, the parts we use.
export interface NewApp {
  id: number;
  slug: string;
  name: string;
  client_id: string;
  client_secret: string;
  webhook_secret: string;
  pem: string;
  html_url: string;
  owner?: { login: string; type: string };
}

// Where the manifest is posted: the person's own account, or an
// organization they own.
export function newAppUrl(org: string | undefined, webUrl = GITHUB_WEB_URL): string {
  return org ? `${webUrl}/organizations/${encodeURIComponent(org)}/settings/apps/new` : `${webUrl}/settings/apps/new`;
}

// Where the person's (or organization's) Apps are listed.
export function appsPageUrl(org: string | undefined, webUrl = GITHUB_WEB_URL): string {
  return org ? `${webUrl}/organizations/${encodeURIComponent(org)}/settings/apps` : `${webUrl}/settings/apps`;
}

// The App's settings page, where device flow is turned on.
export function appSettingsUrl(app: Pick<NewApp, "slug" | "owner">, webUrl = GITHUB_WEB_URL): string {
  return app.owner?.type === "Organization"
    ? `${webUrl}/organizations/${app.owner.login}/settings/apps/${app.slug}`
    : `${webUrl}/settings/apps/${app.slug}`;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// The local page that sends the browser to GitHub with the manifest. It
// has to be a form POST; GitHub doesn't take the manifest in a link.
export function startPage(action: string, manifest: AppManifest): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>watcheroni selfhost</title></head>
<body onload="document.forms[0].submit()">
<form method="post" action="${escapeHtml(action)}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<p>Taking you to GitHub to create the App. <button type="submit">Continue</button></p>
</form>
</body>
</html>
`;
}

const donePage = (message: string) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>watcheroni selfhost</title></head>
<body><p>${escapeHtml(message)}</p></body>
</html>
`;

export interface FlowDeps {
  fetch: typeof fetch;
  // Called with the local page's URL once the server listens; opens it in
  // a browser or tells the person to.
  open: (url: string) => void;
  webUrl?: string;
  apiUrl?: string;
  // 0 picks a free port.
  port?: number;
}

export class ManifestFailed extends Error {}

// Runs the flow on a local server at 127.0.0.1 and resolves with the new
// App once GitHub has converted the code.
export function createApp(manifestFor: (redirectUrl: string) => AppManifest, org: string | undefined, deps: FlowDeps): Promise<NewApp> {
  const webUrl = deps.webUrl ?? GITHUB_WEB_URL;
  const apiUrl = deps.apiUrl ?? GITHUB_API_URL;
  const state = randomBytes(16).toString("hex");

  return new Promise((resolve, reject) => {
    let finished = false;
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const send = (status: number, body: string) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(body);
      };
      const { port } = server.address() as AddressInfo;
      const redirectUrl = `http://127.0.0.1:${port}/callback`;
      // Only the browser on this machine, by this address: a page that
      // points its own hostname at 127.0.0.1 (DNS rebinding) mustn't be
      // able to read the state off "/".
      if (req.headers.host !== `127.0.0.1:${port}`) return send(421, donePage("Wrong address."));

      if (req.method === "GET" && url.pathname === "/") {
        const action = `${newAppUrl(org, webUrl)}?state=${state}`;
        return send(200, startPage(action, manifestFor(redirectUrl)));
      }
      if (req.method !== "GET" || url.pathname !== "/callback") return send(404, donePage("Not found."));
      // Only GitHub's redirect for this run, and only once.
      if (finished) return send(409, donePage("This App has already been created; see the terminal."));
      const code = url.searchParams.get("code");
      if (url.searchParams.get("state") !== state || !code || !/^[\w-]+$/.test(code)) {
        return send(400, donePage("That isn't GitHub's answer for this run of selfhost."));
      }
      finished = true;
      try {
        const answer = await deps.fetch(`${apiUrl}/app-manifests/${code}/conversions`, {
          method: "POST",
          headers: { Accept: "application/vnd.github+json", "User-Agent": "watcheroni-selfhost" },
        });
        if (!answer.ok) throw new ManifestFailed(`GitHub answered ${answer.status} when asked for the new App's details`);
        const app = (await answer.json()) as NewApp;
        if (!app.id || !app.pem || !app.client_id || !app.client_secret || !app.webhook_secret || !app.slug) {
          throw new ManifestFailed("GitHub's answer is missing some of the App's details");
        }
        send(200, donePage(`Created the GitHub App ${app.name}. You can close this tab and go back to the terminal.`));
        resolve(app);
      } catch (e) {
        // GitHub has made the App, but the code works only once, so its
        // key and secrets are out of reach: it has to go.
        const why = e instanceof ManifestFailed ? e.message : `couldn't reach GitHub: ${(e as Error).message}`;
        const failed = new ManifestFailed(
          `${why}. GitHub has probably created the App anyway, and its details can't be fetched again: ` +
            `delete it under ${appsPageUrl(org, webUrl)} (Advanced, "Delete GitHub App"), then run selfhost again`,
        );
        send(502, donePage(`${failed.message}.`));
        reject(failed);
      } finally {
        server.close();
      }
    });
    server.on("error", reject);
    server.listen(deps.port ?? 0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      deps.open(`http://127.0.0.1:${port}/`);
    });
  });
}

// Whether the App has device flow on, which `watcheroni login` needs.
// Starting a device flow is harmless: the code is never shown to anyone
// and expires.
export async function deviceFlowEnabled(clientId: string, f: typeof fetch = fetch, webUrl = GITHUB_WEB_URL): Promise<boolean> {
  const res = await f(`${webUrl}/login/device/code`, {
    method: "POST",
    headers: { Accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId }),
  });
  const body = (await res.json().catch(() => ({}))) as { device_code?: string; error?: string };
  if (body.device_code) return true;
  if (body.error === "device_flow_disabled") return false;
  throw new ManifestFailed(`GitHub answered ${res.status}${body.error ? ` (${body.error})` : ""} when checking device flow`);
}
