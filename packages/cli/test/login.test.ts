import type { spawn, SpawnOptions } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { checkServerUrl, loadServer } from "../src/config.ts";
import {
  browserCommand,
  DEFAULT_SERVER,
  githubTokenFor,
  githubUrl,
  launch,
  type LoginDeps,
  LoginFailed,
  login,
  logout,
  readCredentials,
  serverUrl,
} from "../src/login.ts";
import { ServerClient } from "../src/server.ts";

const SERVER = "https://watcheroni.test";
const GITHUB = "https://github.com";
const DEVICE_PAGE = `${GITHUB}/login/device`;

beforeEach(() => {
  process.env.WATCHERONI_CREDENTIALS = join(mkdtempSync(join(tmpdir(), "watcheroni-cred-")), "credentials.json");
});

// A fake server and GitHub. `answers` are what the token endpoint says, in
// turn, and `loginStatus` what /v1/login answers (one status, or one per call).
function fake(
  answers: Record<string, unknown>[],
  loginStatus: number | number[] = 200,
  canOpen = true,
  page: unknown = DEVICE_PAGE,
  userCode: unknown = "ABCD-1234",
) {
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
          return Response.json({ protocol: 1, server: "t", features: [], limits: {}, github: { client_id: "Iv23cli", web_url: "https://github.evil.test", api_url: "" } });
        case `${GITHUB}/login/device/code`:
          return Response.json({ device_code: "dc", user_code: userCode, verification_uri: page, expires_in: 900, interval: 5 });
        case `${GITHUB}/login/oauth/access_token`:
          return Response.json(answers.shift());
        case `${SERVER}/v1/login`: {
          const status = Array.isArray(loginStatus) ? loginStatus.shift()! : loginStatus;
          if (status === 429) {
            return Response.json({ code: "rate_limited", title: "Too many sign-in requests from this address" }, { status, headers: { "Retry-After": "60" } });
          }
          return status === 200
            ? Response.json({ api_key: "wk2_7_secret_tag", key_id: "key_1", account: { id: 7, login: "octocat" } })
            : Response.json({ title: "nope" }, { status });
        }
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
    expect(a.opened).toEqual([DEVICE_PAGE]);
    expect(a.printed.slice(0, 2)).toEqual([
      "Your one-time code: ABCD-1234",
      `Opening ${DEVICE_PAGE} in your browser; enter the code there. (If it doesn't open, go there yourself.)`,
    ]);
    const b = fake([done], 200, false);
    await login(SERVER, b.deps);
    expect(b.printed[1]).toBe(`Open ${DEVICE_PAGE} and enter the code there.`);
  });

  it("refuses a code page that isn't on github.com, opening and saving nothing", async () => {
    for (const page of [
      "file:///etc/passwd",
      "/Applications/Calculator.app",
      "javascript:alert(1)",
      "http://github.com/login/device",
      "https://github.com.evil.com/login/device",
      "https://evil.com/github.com",
      "https://user@github.com/login/device",
      null,
    ]) {
      const { deps, opened, printed } = fake([{ access_token: "ghu_tok" }], 200, true, page);
      await expect(login(SERVER, deps)).rejects.toThrow(/refusing to send you to .*github\.com/);
      expect(opened).toEqual([]);
      expect(printed).toEqual([]);
      expect(readCredentials().servers).toEqual({});
    }
  });

  it("runs the device flow on github.com, whatever web_url the server names", async () => {
    const { deps, calls } = fake([{ access_token: "ghu_tok" }]);
    await login(SERVER, deps);
    expect(calls.map((c) => c.url)).toEqual([
      `${SERVER}/v1/meta`,
      `${GITHUB}/login/device/code`,
      `${GITHUB}/login/oauth/access_token`,
      `${SERVER}/v1/login`,
    ]);
  });

  it("cleans what it repeats from an answer", async () => {
    const a = fake([{ error: "bad", error_description: "no\x1b[2J\u009b31m‮way\n".repeat(50) }]);
    const err = await login(SERVER, a.deps).catch((e: Error) => e);
    expect(err).toBeInstanceOf(LoginFailed);
    expect((err as Error).message).toMatch(/^GitHub: no \[2J 31m way no/);
    expect((err as Error).message).not.toMatch(/[\x00-\x1f\u0080-\u009f‮]/);
    expect((err as Error).message.length).toBeLessThan(120);

    const b = fake([], 200, true, `https://evil.com/\u009b‮${"x".repeat(1000)}`);
    const refused = await login(SERVER, b.deps).catch((e: Error) => e);
    expect((refused as Error).message).toMatch(/^refusing to send you to "https:\/\/evil\.com\//);
    expect((refused as Error).message).not.toMatch(/[\u0080-\u009f‮]/);
    expect((refused as Error).message.length).toBeLessThan(200);
  });

  it("refuses a one-time code that isn't a plain code", async () => {
    const { deps, printed } = fake([{ access_token: "ghu_tok" }], 200, true, DEVICE_PAGE, "\x1b]8;;https://evil.com\x07ABCD");
    await expect(login(SERVER, deps)).rejects.toThrow(/odd one-time code/);
    expect(printed).toEqual([]);
  });
});

describe("opening the browser", () => {
  it("allows only https pages on github.com, normalised", () => {
    expect(githubUrl("https://github.com/login/device")).toBe("https://github.com/login/device");
    expect(githubUrl("https://GitHub.com/login/device")).toBe("https://github.com/login/device");
    expect(githubUrl("https://github.com:443/login/device")).toBe("https://github.com/login/device");
    // Odd spellings of github.com itself are fine once normalised.
    expect(githubUrl("https:github.com")).toBe("https://github.com/");
    expect(githubUrl("https://%67ithub.com/login/device")).toBe("https://github.com/login/device");
    // Quotes and spaces come out encoded; `&` stays, which is harmless
    // without a shell.
    expect(githubUrl(`https://github.com/a"b c?x=1&y='2'"`)).toBe("https://github.com/a%22b%20c?x=1&y=%272%27%22");
    for (const bad of [
      "file:///Applications/Calculator.app",
      "/Applications/Calculator.app",
      "Calculator.app",
      "javascript:alert(1)",
      "http://github.com/login/device",
      "https://github.com.evil.com/login/device",
      "https://evil.com/github.com",
      "https://evil.com/?https://github.com",
      "https://user@github.com/login/device",
      "https://user:pw@github.com/login/device",
      "https://github.com:8443/login/device",
      "https://github.com./login/device",
      "https://%67ithub.com.evil.com/",
      "https://gіthub.com/login/device", // Cyrillic і
      `https://github.com/${"x".repeat(500)}`,
      "",
      42,
      null,
    ]) {
      expect(githubUrl(bad), String(bad)).toBeNull();
    }
  });

  it("passes the URL as one argument, with no cmd or shell", () => {
    const href = githubUrl("https://github.com/login/device?a=1&b=\"2\"")!;
    expect(browserCommand(href, "darwin", {})).toEqual(["open", href]);
    expect(browserCommand(href, "win32", {})).toEqual(["C:\\Windows\\System32\\rundll32.exe", "url.dll,FileProtocolHandler", href]);
    expect(browserCommand(href, "win32", { SystemRoot: "D:\\Win" })?.[0]).toBe("D:\\Win\\System32\\rundll32.exe");
    expect(browserCommand(href, "linux", { DISPLAY: ":0" })).toEqual(["xdg-open", href]);
    expect(browserCommand(href, "linux", {})).toBeNull();

    const runs: { cmd: string; args: readonly string[]; options: SpawnOptions }[] = [];
    const run = ((cmd: string, args: readonly string[], options: SpawnOptions) => {
      runs.push({ cmd, args, options });
      return { on: () => {}, unref: () => {} };
    }) as unknown as typeof spawn;
    expect(launch(["rundll32", "url.dll,FileProtocolHandler", href], run)).toBe(true);
    expect(runs).toEqual([{ cmd: "rundll32", args: ["url.dll,FileProtocolHandler", href], options: expect.objectContaining({ shell: false }) }]);
  });

  it("survives a launcher that isn't there", async () => {
    expect(launch(["/nonexistent/watcheroni-browser", "https://github.com/"])).toBe(true);
    // The spawn error arrives later and is swallowed.
    await new Promise((r) => setTimeout(r, 50));
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
      api_key: "wk2_7_secret_tag",
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

  it("waits out a 429 once, keeping the GitHub token rather than starting over", async () => {
    const { deps, calls, printed } = fake([{ access_token: "ghu_tok" }], [429, 200]);
    const before = deps.now();
    await login(SERVER, deps);
    expect(printed).toContain(`${SERVER} is limiting sign-ins from this address; trying again in 60 seconds.`);
    expect(deps.now() - before).toBeGreaterThanOrEqual(60_000);
    expect(calls.filter((c) => c.url === `${SERVER}/v1/login`).map((c) => c.body)).toEqual([
      expect.objectContaining({ github_token: "ghu_tok" }),
      expect.objectContaining({ github_token: "ghu_tok" }),
    ]);
    // The device flow ran once.
    expect(calls.filter((c) => c.url === `${GITHUB}/login/device/code`)).toHaveLength(1);
    expect(readCredentials().servers[SERVER]?.api_key).toBe("wk2_7_secret_tag");
  });

  it("says when to try again if it's still limited", async () => {
    const { deps } = fake([{ access_token: "ghu_tok" }], [429, 429]);
    await expect(login(SERVER, deps)).rejects.toThrow(`${SERVER} is limiting sign-ins from this address; try again in 60 seconds`);
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
    expect(calls.at(-1)).toMatchObject({ url: `${SERVER}/v1/keys/current`, auth: "Bearer wk2_7_secret_tag" });
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
      writeFileSync(process.env.WATCHERONI_CREDENTIALS!, JSON.stringify({ servers: { [DEFAULT_SERVER]: { api_key: "wk2_7_secret_tag" } } }));
      expect(loadServer()).toEqual({ url: DEFAULT_SERVER, apiKey: "wk2_7_secret_tag" });
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
      process.env.WATCHERONI_API_KEY = "wk2_7_secret_tag";
      process.env.WATCHERONI_SERVER = "http://watcheroni.dev";
      expect(() => loadServer()).toThrow(/^http:\/\/watcheroni\.dev: the server must be https/);
      expect(() => serverUrl()).toThrow(/must be https/);
      delete process.env.WATCHERONI_SERVER;
      writeFileSync(join(process.env.WATCHERONI_CONFIG_DIR, "config.json"), JSON.stringify({ server: "http://localhost.evil.com" }));
      expect(() => loadServer()).toThrow(/^http:\/\/localhost\.evil\.com: the server must be https/);
      expect(() => new ServerClient({ url: "http://watcheroni.dev", apiKey: "wk2_7_secret_tag" })).toThrow(/must be https/);

      // Nor is anything sent to a server named outright.
      const { deps, calls } = fake([{ access_token: "ghu_tok" }]);
      await expect(login("http://watcheroni.test", deps)).rejects.toThrow(/must be https/);
      await expect(logout("http://watcheroni.test", deps)).rejects.toThrow(/must be https/);
      writeFileSync(process.env.WATCHERONI_CREDENTIALS!, JSON.stringify({
        servers: { "http://watcheroni.test": { api_key: "wk2_7_secret_tag", github: { access_token: "ghu_old", refresh_token: "ghr_tok", expires_at: new Date(0).toISOString() } } },
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
