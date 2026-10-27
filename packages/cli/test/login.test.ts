import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadServer } from "../src/config.ts";
import { DEFAULT_SERVER, type LoginDeps, LoginFailed, login, logout, readCredentials } from "../src/login.ts";

const SERVER = "https://watcheroni.test";
const GITHUB = "https://github.test";

beforeEach(() => {
  process.env.WATCHERONI_CREDENTIALS = join(mkdtempSync(join(tmpdir(), "watcheroni-cred-")), "credentials.json");
});

// A fake server and GitHub. `answers` are what the token endpoint says, in turn.
function fake(answers: Record<string, unknown>[], loginStatus = 200) {
  const calls: { url: string; body: unknown; auth: string | null }[] = [];
  let clock = 0;
  const deps: LoginDeps = {
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    print: () => {},
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
  return { deps, calls };
}

describe("login", () => {
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
