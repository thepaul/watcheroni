import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { checkServerUrl, loadServer } from "../src/config.ts";
import { DEFAULT_SERVER, type LoginDeps, LoginFailed, githubTokenFor, login, logout, readCredentials, serverUrl } from "../src/login.ts";
import { ServerClient } from "../src/server.ts";

const SERVER = "https://watcheroni.test";
const GITHUB = "https://github.test";

beforeEach(() => {
  process.env.WATCHERONI_CREDENTIALS = join(mkdtempSync(join(tmpdir(), "watcheroni-cred-")), "credentials.json");
});

// A fake server and GitHub. `answers` are what the token endpoint says, in turn.
function fake(answers: Record<string, unknown>[], loginStatus = 200, canOpen = true) {
  const calls: { url: string; body: unknown; auth: string | null }[] = [];
  const opened: string[] = [];
  const printed: string[] = [];
  let clock = 0;
  const deps: LoginDeps = {
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    print: (line) => void printed.push(line),
    openUrl: (url) => (opened.push(url), canOpen),
    fetch: async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, body, auth: new Headers(init?.headers).get("Authorization") });
      switch (url) {
        case `${SERVER}/v1/meta`:
          return Response.json({ protocol: 1, server: "t", features: [], limits: {}, github: { client_id: "Iv23cli", web_url: GITHUB, api_url: "" } });
        case `${GITHUB}/login/device/code`:
          return Response.json({ device_code: "dc", user_code: "ABCD-1234", verification_uri: `${GITHUB}/login/device`, expires_in: 900, interval: 5 });
        case `${GITHUB}/login/oauth/access_token`:
          return Response.json(answers.shift());
        case `${SERVER}/v1/login`:
          return loginStatus === 200
            ? Response.json({ api_key: "wk1_7_secret", key_id: "key_1", account: { id: 7, login: "octocat" } })
            : Response.json({ title: "nope" }, { status: loginStatus });
        case `${SERVER}/v1/keys/current`:
          return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected ${url}`);
    },
  };
  return { deps, calls, opened, printed };
}

describe("login", () => {
  it("opens the browser at the device page, or says where to go", async () => {
    const done = { access_token: "ghu_tok" };
    const a = fake([done]);
    await login(SERVER, a.deps);
    expect(a.opened).toEqual([`${GITHUB}/login/device`]);
    expect(a.printed.slice(0, 2)).toEqual([
      "Your one-time code: ABCD-1234",
      `Opening ${GITHUB}/login/device in your browser; enter the code there. (If it doesn't open, go there yourself.)`,
    ]);
    const b = fake([done], 200, false);
    await login(SERVER, b.deps);
    expect(b.printed[1]).toBe(`Open ${GITHUB}/login/device and enter the code there.`);
  });

  it("runs the device flow, trades the token for a key, and keeps both locally", async () => {
    const { deps, calls } = fake([
      { error: "authorization_pending" },
      { error: "slow_down", interval: 10 },
      { access_token: "ghu_tok", refresh_token: "ghr_tok", expires_in: 28800, refresh_token_expires_in: 15811200 },
    ]);
    await login(SERVER, deps);
    expect(calls.find((c) => c.url === `${SERVER}/v1/login`)?.body).toMatchObject({ github_token: "ghu_tok" });
    const creds = readCredentials();
    expect(creds.servers[SERVER]).toMatchObject({
      api_key: "wk1_7_secret",
      account: { id: 7, login: "octocat" },
      github: { access_token: "ghu_tok", refresh_token: "ghr_tok" },
    });
    expect(statSync(process.env.WATCHERONI_CREDENTIALS!).mode & 0o777).toBe(0o600);
  });

  it("stops when the user cancels, saving nothing", async () => {
    const { deps } = fake([{ error: "access_denied" }]);
    await expect(login(SERVER, deps)).rejects.toThrow(LoginFailed);
    expect(readCredentials().servers).toEqual({});
  });

  it("reports the server refusing the token", async () => {
    const { deps } = fake([{ access_token: "ghu_tok" }], 401);
    await expect(login(SERVER, deps)).rejects.toThrow(/refused.*401.*nope/);
  });
});

describe("logout", () => {
  it("revokes the key and forgets the credentials", async () => {
    const { deps, calls } = fake([{ access_token: "ghu_tok" }]);
    await login(SERVER, deps);
    expect(await logout(SERVER, deps)).toBe(true);
    expect(calls.at(-1)).toMatchObject({ url: `${SERVER}/v1/keys/current`, auth: "Bearer wk1_7_secret" });
    expect(JSON.parse(readFileSync(process.env.WATCHERONI_CREDENTIALS!, "utf8")).servers).toEqual({});
    expect(await logout(SERVER, deps)).toBe(false);
  });
});

describe("choosing the server", () => {
  it("uses the default server once signed in to it, and local mode before", () => {
    const saved = { ...process.env };
    try {
      process.env.WATCHERONI_CONFIG_DIR = mkdtempSync(join(tmpdir(), "watcheroni-config-"));
      delete process.env.WATCHERONI_SERVER;
      delete process.env.WATCHERONI_API_KEY;
      expect(loadServer()).toBeNull();
      writeFileSync(process.env.WATCHERONI_CREDENTIALS!, JSON.stringify({ servers: { [DEFAULT_SERVER]: { api_key: "wk1_7_secret" } } }));
      expect(loadServer()).toEqual({ url: DEFAULT_SERVER, apiKey: "wk1_7_secret" });
      process.env.WATCHERONI_SERVER = "";
      expect(loadServer()).toBeNull();
    } finally {
      process.env = saved;
    }
  });
});

describe("the server URL", () => {
  it("is https, or plain http only to this machine", () => {
    for (const url of [
      "https://watcheroni.dev",
      "HTTPS://watcheroni.dev",
      "https://watcheroni.dev:8443/base",
      "http://localhost:8787",
      "HTTP://LOCALHOST:8787",
      "http://dev.localhost",
      "http://127.0.0.1:8787",
      "http://127.1.2.3",
      "http://127.1",
      "http://0x7f.0.0.1",
      "http://[::1]:8787",
    ]) expect(checkServerUrl(url), url).toBe(url);
    for (const url of [
      "http://watcheroni.dev",
      "HTTP://watcheroni.dev",
      "http://localhost.evil.com",
      "http://localhost.",
      "http://127.0.0.1.nip.io",
      "http://128.0.0.1",
      "http://10.0.0.1",
      "http://[::2]",
      "http://[::ffff:127.0.0.1]",
      "http://localhost@evil.com",
      "http://127.0.0.1:80@evil.com",
    ]) expect(() => checkServerUrl(url), url).toThrow(/must be https; plain http is only for localhost/);
  });

  it("refuses other schemes, non-URLs and credentials in the URL", () => {
    for (const url of ["ws://localhost", "wss://watcheroni.dev", "ftp://watcheroni.dev", "file:///tmp/x", "watcheroni.dev", ""]) {
      expect(() => checkServerUrl(url), url).toThrow(/must be an https URL/);
    }
    for (const url of ["https://me:pw@watcheroni.dev", "https://me@watcheroni.dev", "http://me:pw@localhost"]) {
      expect(() => checkServerUrl(url), url).toThrow(/can't hold a user name or password/);
    }
  });

  it("drops trailing slashes", () => {
    expect(checkServerUrl("https://watcheroni.dev//")).toBe("https://watcheroni.dev");
  });

  it("is checked wherever one comes in", async () => {
    const saved = { ...process.env };
    try {
      process.env.WATCHERONI_CONFIG_DIR = mkdtempSync(join(tmpdir(), "watcheroni-config-"));
      process.env.WATCHERONI_API_KEY = "wk1_7_secret";
      process.env.WATCHERONI_SERVER = "http://watcheroni.dev";
      expect(() => loadServer()).toThrow(/^http:\/\/watcheroni\.dev: the server must be https/);
      expect(() => serverUrl()).toThrow(/must be https/);
      delete process.env.WATCHERONI_SERVER;
      writeFileSync(join(process.env.WATCHERONI_CONFIG_DIR, "config.json"), JSON.stringify({ server: "http://localhost.evil.com" }));
      expect(() => loadServer()).toThrow(/^http:\/\/localhost\.evil\.com: the server must be https/);
      expect(() => new ServerClient({ url: "http://watcheroni.dev", apiKey: "wk1_7_secret" })).toThrow(/must be https/);

      // Nor is anything sent to a server named outright.
      const { deps, calls } = fake([{ access_token: "ghu_tok" }]);
      await expect(login("http://watcheroni.test", deps)).rejects.toThrow(/must be https/);
      await expect(logout("http://watcheroni.test", deps)).rejects.toThrow(/must be https/);
      writeFileSync(process.env.WATCHERONI_CREDENTIALS!, JSON.stringify({
        servers: { "http://watcheroni.test": { api_key: "wk1_7_secret", github: { access_token: "ghu_old", refresh_token: "ghr_tok", expires_at: new Date(0).toISOString() } } },
      }));
      await expect(githubTokenFor("http://watcheroni.test", deps)).rejects.toThrow(/must be https/);
      expect(calls).toEqual([]);
    } finally {
      process.env = saved;
    }
  });

  it("gives a WebSocket URL to match", async () => {
    const socket = (url: string) => new ServerClient({ url, apiKey: "k" }).socket("box").then((s) => s.url);
    expect(await socket("https://watcheroni.dev")).toBe("wss://watcheroni.dev/v1/inboxes/box/ws");
    expect(await socket("http://localhost:8787")).toBe("ws://localhost:8787/v1/inboxes/box/ws");
  });
});
