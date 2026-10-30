// `watcheroni login` and `logout` (PROTOCOL.md, "Signing in"). The CLI
// runs GitHub's device flow itself, hands the user token to the server
// once for an API key, and keeps the GitHub tokens on this machine.

import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, win32 } from "node:path";
import type { LoginResponse, Meta } from "@watcheroni/protocol";
import { checkServerUrl, configDir, serverSetting } from "./config.ts";
import { clean } from "./format.ts";
import { Unreachable } from "./server.ts";

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

// The only host the CLI signs in at or sends anyone to. The server names
// GitHub's web URL in /v1/meta, but neither it nor anyone between it and
// us gets to choose where the device flow runs or what this machine
// opens. The server only speaks to github.com, so there's no Enterprise
// host to allow.
const GITHUB_HOST = "github.com";
const GITHUB_WEB_URL = `https://${GITHUB_HOST}`;

// `url` normalised, if it's an https page on github.com with no user or
// password in it; null otherwise. Anything else could be a local file or
// app (`open /Applications/...`), another scheme, or a look-alike host.
export function githubUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== GITHUB_HOST || parsed.port || parsed.username || parsed.password) return null;
  return parsed.href.length > 500 ? null : parsed.href;
}

// The program and arguments that open `href` in a browser: the URL is
// one argument, and no shell (such as `cmd /c start`) gets to read `&`
// or quotes in it. Null where there's no way to. rundll32 is named by
// full path, since Windows looks in the current directory before PATH.
export function browserCommand(href: string, platform: string, env: NodeJS.ProcessEnv): string[] | null {
  if (platform === "darwin") return ["open", href];
  if (platform === "win32") return [win32.join(env.SystemRoot || "C:\\Windows", "System32", "rundll32.exe"), "url.dll,FileProtocolHandler", href];
  if (env.DISPLAY || env.WAYLAND_DISPLAY) return ["xdg-open", href];
  return null;
}

// Starts `command` in the background, never through a shell.
export function launch(command: string[], run: typeof spawn = spawn): boolean {
  const [cmd, ...args] = command;
  try {
    const child = run(cmd, args, { stdio: "ignore", detached: true, shell: false });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// Only for someone at this machine's own screen: not when output goes to
// a file or another program, not over SSH, and not when turned off. And
// only a github.com page.
function openUrl(url: string): boolean {
  if (!process.stderr.isTTY || process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.WATCHERONI_NO_BROWSER) return false;
  const href = githubUrl(url);
  const command = href && browserCommand(href, process.platform, process.env);
  return command ? launch(command) : false;
}

export function serverUrl(): string {
  return checkServerUrl(serverSetting() || DEFAULT_SERVER);
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
  server = checkServerUrl(server);
  const { fetch, print } = deps;
  const metaRes = await fetch(`${server}/v1/meta`);
  if (!metaRes.ok) throw new LoginFailed(`${server}/v1/meta answered ${metaRes.status}`);
  const meta = (await metaRes.json()) as Meta;
  if (!meta.github?.client_id) throw new LoginFailed(`${server} doesn't offer sign-in yet`);
  // The server's web_url is ignored: the device flow always runs on
  // github.com.
  const token = await deviceFlow(GITHUB_WEB_URL, meta.github.client_id, deps);

  const send = () =>
    fetch(`${server}/v1/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ github_token: token.access_token, label: `watcheroni CLI on ${hostname()}` }),
    });
  let res = await send();
  // Too many sign-ins from this address. The GitHub token is still good,
  // so rather than send the user through the device flow again, wait once
  // if it isn't long.
  if (res.status === 429) {
    const wait = retryAfter(res);
    if (wait > MAX_LOGIN_WAIT_SECONDS) throw new LoginFailed(signInsLimited(server, wait));
    print(`${server} is limiting sign-ins from this address; trying again in ${wait} seconds.`);
    await deps.sleep(wait * 1000);
    res = await send();
    if (res.status === 429) throw new LoginFailed(signInsLimited(server, retryAfter(res)));
  }
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

// The longest a login waits out a 429 before giving up.
const MAX_LOGIN_WAIT_SECONDS = 120;

function signInsLimited(server: string, wait: number): string {
  return `${server} is limiting sign-ins from this address; try again in ${wait} seconds`;
}

// A 429's Retry-After in seconds; the server always sends one.
function retryAfter(res: Response): number {
  const n = Number(res.headers.get("Retry-After"));
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 60;
}

// Revokes this machine's key on the server and forgets the credentials.
// False if there was nothing to forget.
export async function logout(server = serverUrl(), deps: LoginDeps = defaultDeps): Promise<boolean> {
  server = checkServerUrl(server);
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
// saved. Null if there's none, or it can't be renewed. Throws
// Unreachable when the server can't refresh it just now (no answer, a
// 429 or a 5xx), which `watcheroni login` wouldn't fix.
export async function githubTokenFor(server: string, deps: Pick<LoginDeps, "fetch" | "now"> = defaultDeps): Promise<string | null> {
  server = checkServerUrl(server);
  const github = readCredentials().servers[server]?.github;
  if (!github?.access_token) return null;
  const now = deps.now();
  const expiresAt = github.expires_at ? Date.parse(github.expires_at) : Infinity;
  if (expiresAt - now > TOKEN_MARGIN_MS) return github.access_token;
  const refreshExpiresAt = github.refresh_token_expires_at ? Date.parse(github.refresh_token_expires_at) : Infinity;
  if (!github.refresh_token || refreshExpiresAt <= now) return null;
  let res: Response;
  try {
    res = await deps.fetch(`${server}/v1/github/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: github.refresh_token }),
    });
  } catch (e) {
    const cause = (e as Error & { cause?: Error }).cause;
    throw new Unreachable(`can't reach ${server} to refresh the GitHub token: ${cause?.message ?? (e as Error).message}`);
  }
  if (res.status === 429) {
    throw new Unreachable(`${server} is limiting GitHub token refreshes from this address; try again in ${retryAfter(res)} seconds`);
  }
  if (res.status >= 500) throw new Unreachable(`${server} couldn't refresh the GitHub token (${res.status})`);
  let token: Partial<TokenResponse> & { error?: string };
  try {
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
  if (typeof code.device_code !== "string") throw new LoginFailed(`GitHub didn't start the device flow: ${clean(JSON.stringify(code))}`);
  // Checked anyway before the user is sent anywhere. GitHub's code page
  // is always on github.com; any other address stops the sign-in rather
  // than leaving the user to judge it.
  const uri = githubUrl(code.verification_uri);
  if (!uri) throw new LoginFailed(`refusing to send you to ${JSON.stringify(clean(code.verification_uri))}: it isn't an https page on ${GITHUB_HOST}`);
  if (typeof code.user_code !== "string" || !/^[\w-]{1,32}$/.test(code.user_code)) {
    throw new LoginFailed(`GitHub sent an odd one-time code: ${JSON.stringify(clean(code.user_code))}`);
  }
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
        throw new LoginFailed(`GitHub: ${clean(answer.error_description ?? answer.error ?? "unexpected answer")}`);
    }
  }
  throw new LoginFailed("the code expired; run `watcheroni login` again");
}
