// `watcheroni login` and `logout` (PROTOCOL.md, "Signing in"). The CLI
// runs GitHub's device flow itself, hands the user token to the server
// once for an API key, and keeps the GitHub tokens on this machine.

import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { LoginResponse, Meta } from "@watcheroni/protocol";
import { configDir, serverSetting } from "./config.ts";

export const DEFAULT_SERVER = "https://watcheroni.dev";

export interface ServerCredentials {
  api_key: string;
  key_id: string;
  account: { id: number; login: string };
  github: {
    access_token: string;
    refresh_token: string | null;
    expires_at: string | null;
    refresh_token_expires_at: string | null;
  };
}

// ~/.config/watcheroni/credentials.json, mode 0600, keyed by server URL.
export interface Credentials {
  servers: { [server: string]: ServerCredentials };
}

export interface LoginDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  print: (line: string) => void;
  now: () => number;
  // Opens the URL in a browser; false if it didn't try.
  openUrl: (url: string) => boolean;
}

const defaultDeps: LoginDeps = {
  fetch: (...args) => fetch(...args),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  print: (line) => process.stderr.write(`${line}\n`),
  now: () => Date.now(),
  openUrl,
};

// Only for someone at this machine's own screen: not when output goes to
// a file or another program, not over SSH, and not when turned off.
function openUrl(url: string): boolean {
  if (!process.stderr.isTTY || process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.WATCHERONI_NO_BROWSER) return false;
  const [cmd, ...args] =
    process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["cmd", "/c", "start", "", url]
    : process.env.DISPLAY || process.env.WAYLAND_DISPLAY ? ["xdg-open", url]
    : [];
  if (!cmd) return false;
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function serverUrl(): string {
  return (serverSetting() || DEFAULT_SERVER).replace(/\/+$/, "");
}

export function credentialsPath(): string {
  if (process.env.WATCHERONI_CREDENTIALS) return process.env.WATCHERONI_CREDENTIALS;
  return join(configDir(), "credentials.json");
}

export function readCredentials(path = credentialsPath()): Credentials {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Credentials;
    return { servers: parsed.servers ?? {} };
  } catch {
    return { servers: {} };
  }
}

function writeCredentials(creds: Credentials, path = credentialsPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(creds, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export class LoginFailed extends Error {}

export async function login(server = serverUrl(), deps: LoginDeps = defaultDeps): Promise<ServerCredentials> {
  const { fetch, print } = deps;
  const metaRes = await fetch(`${server}/v1/meta`);
  if (!metaRes.ok) throw new LoginFailed(`${server}/v1/meta answered ${metaRes.status}`);
  const meta = (await metaRes.json()) as Meta;
  if (!meta.github?.client_id) throw new LoginFailed(`${server} doesn't offer sign-in yet`);
  const { client_id, web_url } = meta.github;

  const token = await deviceFlow(web_url, client_id, deps);

  const res = await fetch(`${server}/v1/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ github_token: token.access_token, label: `watcheroni CLI on ${hostname()}` }),
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { title?: string };
    throw new LoginFailed(`the server refused the login (${res.status}${problem.title ? `: ${problem.title}` : ""})`);
  }
  const body = (await res.json()) as LoginResponse;
  const now = deps.now();
  const entry: ServerCredentials = {
    api_key: body.api_key,
    key_id: body.key_id,
    account: body.account,
    github: {
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? null,
      expires_at: token.expires_in ? new Date(now + token.expires_in * 1000).toISOString() : null,
      refresh_token_expires_at: token.refresh_token_expires_in
        ? new Date(now + token.refresh_token_expires_in * 1000).toISOString()
        : null,
    },
  };
  const creds = readCredentials();
  creds.servers[server] = entry;
  writeCredentials(creds);
  print(`Signed in to ${server} as ${body.account.login}.`);
  return entry;
}

// Revokes this machine's key on the server and forgets the credentials.
// False if there was nothing to forget.
export async function logout(server = serverUrl(), deps: LoginDeps = defaultDeps): Promise<boolean> {
  const creds = readCredentials();
  const entry = creds.servers[server];
  if (!entry) {
    deps.print(`Not signed in to ${server}.`);
    return false;
  }
  try {
    const res = await deps.fetch(`${server}/v1/keys/current`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${entry.api_key}` },
    });
    // 401: already revoked, which is what we wanted.
    if (!res.ok && res.status !== 401) deps.print(`The server didn't revoke the key (${res.status}); forgetting it anyway.`);
  } catch (e) {
    deps.print(`Couldn't reach ${server} to revoke the key (${(e as Error).message}); forgetting it anyway.`);
  }
  delete creds.servers[server];
  writeCredentials(creds);
  deps.print(`Signed out of ${server}.`);
  return true;
}

// The GitHub token `watcheroni login` saved for the server, for
// subscribing to private repos. An expired one is renewed through the
// server's refresh proxy (PROTOCOL.md, "Refreshing the GitHub token") and
// saved. Null if there's none, or it can't be renewed.
export async function githubTokenFor(server: string, deps: Pick<LoginDeps, "fetch" | "now"> = defaultDeps): Promise<string | null> {
  const github = readCredentials().servers[server]?.github;
  if (!github?.access_token) return null;
  const now = deps.now();
  const expiresAt = github.expires_at ? Date.parse(github.expires_at) : Infinity;
  if (expiresAt - now > TOKEN_MARGIN_MS) return github.access_token;
  const refreshExpiresAt = github.refresh_token_expires_at ? Date.parse(github.refresh_token_expires_at) : Infinity;
  if (!github.refresh_token || refreshExpiresAt <= now) return null;
  let token: Partial<TokenResponse> & { error?: string };
  try {
    const res = await deps.fetch(`${server}/v1/github/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: github.refresh_token }),
    });
    token = (await res.json()) as typeof token;
  } catch {
    return null;
  }
  if (typeof token.access_token !== "string") return null;
  // Read again, in case another process changed the file meanwhile.
  const creds = readCredentials();
  const entry = creds.servers[server];
  if (!entry) return token.access_token;
  entry.github = {
    access_token: token.access_token,
    // GitHub rotates the refresh token on every use.
    refresh_token: token.refresh_token ?? null,
    expires_at: token.expires_in ? new Date(now + token.expires_in * 1000).toISOString() : null,
    refresh_token_expires_at: token.refresh_token_expires_in
      ? new Date(now + token.refresh_token_expires_in * 1000).toISOString()
      : null,
  };
  writeCredentials(creds);
  return token.access_token;
}

// A token is renewed when it has less than this left.
const TOKEN_MARGIN_MS = 5 * 60_000;

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
}

// https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-device-flow-to-generate-a-user-access-token
async function deviceFlow(webUrl: string, clientId: string, deps: LoginDeps): Promise<TokenResponse> {
  const post = async (path: string, body: Record<string, string>) => {
    const res = await deps.fetch(`${webUrl}${path}`, {
      method: "POST",
      headers: { Accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new LoginFailed(`GitHub answered ${res.status} to ${path}`);
    return res.json() as Promise<Record<string, unknown>>;
  };

  const code = await post("/login/device/code", { client_id: clientId });
  if (typeof code.device_code !== "string") throw new LoginFailed(`GitHub didn't start the device flow: ${JSON.stringify(code)}`);
  const uri = String(code.verification_uri);
  deps.print(`Your one-time code: ${code.user_code}`);
  deps.print(deps.openUrl(uri)
    ? `Opening ${uri} in your browser; enter the code there. (If it doesn't open, go there yourself.)`
    : `Open ${uri} and enter the code there.`);
  deps.print("");
  deps.print(`GitHub will ask whether watcheroni may "act on your behalf". That's its wording for`);
  deps.print("every app sign-in. watcheroni can only read pull requests, reviews, checks, issues and");
  deps.print("Actions runs, on repos it's installed on that you can see. It can't change anything,");
  deps.print("and the server doesn't keep the token.");
  deps.print("");

  let interval = Number(code.interval ?? 5) * 1000;
  const deadline = deps.now() + Number(code.expires_in ?? 900) * 1000;
  while (deps.now() < deadline) {
    await deps.sleep(interval);
    const answer = await post("/login/oauth/access_token", {
      client_id: clientId,
      device_code: code.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (typeof answer.access_token === "string") return answer as unknown as TokenResponse;
    switch (answer.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval = Number(answer.interval ?? interval / 1000 + 5) * 1000;
        continue;
      case "access_denied":
        throw new LoginFailed("sign-in was cancelled on GitHub");
      case "expired_token":
        throw new LoginFailed("the code expired; run `watcheroni login` again");
      default:
        throw new LoginFailed(`GitHub: ${answer.error_description ?? answer.error ?? "unexpected answer"}`);
    }
  }
  throw new LoginFailed("the code expired; run `watcheroni login` again");
}
