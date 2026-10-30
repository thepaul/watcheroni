import type { spawn, SpawnOptions } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadServer } from "../src/config.ts";
import {
  browserCommand,
  DEFAULT_SERVER,
  githubUrl,
  launch,
  type LoginDeps,
  LoginFailed,
  login,
  logout,
  readCredentials,
} from "../src/login.ts";

const SERVER = "https://watcheroni.test";
const GITHUB = "https://github.test";
const DEVICE_PAGE = "https://github.com/login/device";

beforeEach(() => {
  process.env.WATCHERONI_CREDENTIALS = join(mkdtempSync(join(tmpdir(), "watcheroni-cred-")), "credentials.json");
});

// A fake server and GitHub. `answers` are what the token endpoint says, in turn.
function fake(answers: Record<string, unknown>[], loginStatus = 200, canOpen = true, page: unknown = DEVICE_PAGE, userCode: unknown = "ABCD-1234") {
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
          return Response.json({ device_code: "dc", user_code: userCode, verification_uri: page, expires_in: 900, interval: 5 });
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
    expect(browserCommand(href, "win32", {})).toEqual(["rundll32", "url.dll,FileProtocolHandler", href]);
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
