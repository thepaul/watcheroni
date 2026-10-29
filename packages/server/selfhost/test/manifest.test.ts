import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { type NewApp, ManifestFailed, appManifest, appSettingsUrl, createApp, deviceFlowEnabled, newAppUrl } from "../manifest.ts";

const SERVER = "https://watcheroni.acme.workers.dev";
const API = "https://api.github.test";
const WEB = "https://github.test";

const APP: NewApp = {
  id: 42,
  slug: "watcheroni-acme",
  name: "watcheroni-acme",
  client_id: "Iv23mine",
  client_secret: "cs",
  webhook_secret: "ws",
  pem: "-----BEGIN RSA PRIVATE KEY-----\n...",
  html_url: "https://github.com/apps/watcheroni-acme",
  owner: { login: "acme", type: "Organization" },
};

describe("appManifest", () => {
  it("asks for DESIGN.md's read-only permissions and events, with this server's URLs", () => {
    const m = appManifest({ server: SERVER, appName: "watcheroni-acme", public: false });
    expect(m.hook_attributes).toEqual({ url: `${SERVER}/github/webhook`, active: true });
    expect(m.setup_url).toBe(`${SERVER}/github/setup`);
    expect(m.url).toBe(SERVER);
    expect(m.public).toBe(false);
    expect(m.request_oauth_on_install).toBe(false);
    expect(Object.values(m.default_permissions).every((v) => v === "read")).toBe(true);
    expect(Object.keys(m.default_permissions).sort()).toEqual(["actions", "checks", "issues", "metadata", "pull_requests", "statuses"]);
    expect(m.default_events).toContain("pull_request_review_thread");
    expect(m.default_events).toContain("workflow_run");
    expect(m.default_events).toHaveLength(10);
  });

  it("posts to the person's account or an organization, whose settings page is elsewhere too", () => {
    expect(newAppUrl(undefined, WEB)).toBe(`${WEB}/settings/apps/new`);
    expect(newAppUrl("acme", WEB)).toBe(`${WEB}/organizations/acme/settings/apps/new`);
    expect(appSettingsUrl(APP, WEB)).toBe(`${WEB}/organizations/acme/settings/apps/watcheroni-acme`);
    expect(appSettingsUrl({ slug: "w", owner: { login: "mona", type: "User" } }, WEB)).toBe(`${WEB}/settings/apps/w`);
  });
});

// The manifest flow against a stubbed GitHub: the test plays the browser.
describe("createApp", () => {
  function start(conversion: () => Response | Promise<Response>) {
    const calls: string[] = [];
    let opened!: (url: string) => void;
    const page = new Promise<string>((r) => (opened = r));
    const result = createApp(
      (redirectUrl) => ({ ...appManifest({ server: SERVER, appName: "watcheroni-acme", public: false }), redirect_url: redirectUrl }),
      "acme",
      {
        webUrl: WEB,
        apiUrl: API,
        open: opened,
        fetch: async (input, init) => {
          calls.push(`${init?.method} ${String(input)}`);
          return conversion();
        },
      },
    );
    return { calls, page, result };
  }

  // What GitHub's page would do: read the form, and come back with a code.
  async function form(page: string) {
    const html = await (await fetch(page)).text();
    const action = html.match(/action="([^"]+)"/)![1].replace(/&amp;/g, "&");
    const manifest = JSON.parse(html.match(/name="manifest" value="([^"]+)"/)![1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
    return { action: new URL(action), manifest };
  }

  it("posts the manifest to GitHub, and swaps the code it sends back for the App", async () => {
    const { calls, page, result } = start(() => Response.json(APP, { status: 201 }));
    const pageUrl = await page;
    expect(pageUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const { action, manifest } = await form(pageUrl);
    expect(`${action.origin}${action.pathname}`).toBe(`${WEB}/organizations/acme/settings/apps/new`);
    expect(manifest.redirect_url).toBe(`${pageUrl}callback`);
    expect(manifest.hook_attributes.url).toBe(`${SERVER}/github/webhook`);
    const state = action.searchParams.get("state")!;
    expect(state).toMatch(/^[0-9a-f]{32}$/);

    // Something else calling back is turned away, and doesn't end the flow.
    const forged = await fetch(`${manifest.redirect_url}?code=abc&state=nope`);
    expect(forged.status).toBe(400);
    expect(calls).toEqual([]);

    const done = await fetch(`${manifest.redirect_url}?code=abc123&state=${state}`);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("Created the GitHub App watcheroni-acme");
    expect(await result).toEqual(APP);
    expect(calls).toEqual([`POST ${API}/app-manifests/abc123/conversions`]);
  });

  it("fails if GitHub won't convert the code, saying to delete the App it made", async () => {
    const { page, result } = start(() => Response.json({ message: "Not Found" }, { status: 404 }));
    const { action, manifest } = await form(await page);
    const failed = expect(result).rejects.toThrow(
      new ManifestFailed(
        "GitHub answered 404 when asked for the new App's details. GitHub has probably created the App anyway, and its " +
          `details can't be fetched again: delete it under ${WEB}/organizations/acme/settings/apps (Advanced, "Delete GitHub App"), ` +
          "then run selfhost again",
      ),
    );
    const res = await fetch(`${manifest.redirect_url}?code=abc&state=${action.searchParams.get("state")}`);
    expect(res.status).toBe(502);
    await failed;
  });

  it("answers only requests addressed to 127.0.0.1, against DNS rebinding", async () => {
    const { page, result, calls } = start(() => Response.json(APP, { status: 201 }));
    const pageUrl = new URL(await page);
    const get = (path: string, host: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: pageUrl.port, path, headers: { Host: host } }, (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () => resolve({ status: res.statusCode!, body }));
        });
        req.on("error", reject);
        req.end();
      });
    for (const host of [`evil.example:${pageUrl.port}`, `localhost:${pageUrl.port}`, "127.0.0.1"]) {
      const res = await get("/", host);
      expect(res.status).toBe(421);
      expect(res.body).not.toContain("state=");
    }
    expect((await get("/callback?code=abc&state=x", `evil.example:${pageUrl.port}`)).status).toBe(421);
    expect(calls).toEqual([]);

    // The real thing still works.
    const { action, manifest } = await form(pageUrl.href);
    await fetch(`${manifest.redirect_url}?code=abc&state=${action.searchParams.get("state")}`);
    expect((await result).id).toBe(42);
  });
});

describe("deviceFlowEnabled", () => {
  const answering = (body: object) => (async () => Response.json(body)) as typeof fetch;
  it("tells from GitHub's answer to starting a device flow", async () => {
    expect(await deviceFlowEnabled("Iv23", answering({ device_code: "dc", user_code: "X" }), WEB)).toBe(true);
    expect(await deviceFlowEnabled("Iv23", answering({ error: "device_flow_disabled" }), WEB)).toBe(false);
    await expect(deviceFlowEnabled("Iv23", answering({ error: "unauthorized_client" }), WEB)).rejects.toThrow(ManifestFailed);
  });
});
