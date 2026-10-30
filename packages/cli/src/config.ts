import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LoginNeeded } from "./github.ts";
import { DEFAULT_SERVER, credentialsPath, readCredentials } from "./login.ts";
import { UsageError } from "./targets.ts";

// Which server to use, and the API key for it. With no server configured
// the CLI works as before, polling GitHub from this machine.
//
//   ~/.config/watcheroni/config.json        {"server": "https://..."}
//   ~/.config/watcheroni/credentials.json   {"servers": {"https://...": {"api_key": "wk2_..."}}}
//
// WATCHERONI_SERVER and WATCHERONI_API_KEY override both, for CI. An empty
// WATCHERONI_SERVER means local mode whatever config.json says. With
// neither set, signing in to the default server (`watcheroni login`) is
// enough to use it. Wherever it comes from, the URL goes through
// checkServerUrl.

export interface ServerConfig {
  url: string;
  apiKey: string;
}

export function configDir(): string {
  if (process.env.WATCHERONI_CONFIG_DIR) return process.env.WATCHERONI_CONFIG_DIR;
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "watcheroni");
}

// The server named by WATCHERONI_SERVER or config.json, if either says.
export function serverSetting(): string | undefined {
  return process.env.WATCHERONI_SERVER ?? readJson<{ server?: string }>(join(configDir(), "config.json"))?.server;
}

export function loadServer(): ServerConfig | null {
  const credentials = readCredentials();
  const raw = serverSetting() ?? (credentials.servers[DEFAULT_SERVER] ? DEFAULT_SERVER : "");
  if (!raw) return null;
  const url = checkServerUrl(raw);
  const apiKey = process.env.WATCHERONI_API_KEY || credentials.servers[url]?.api_key;
  if (!apiKey) {
    throw new LoginNeeded(`No API key for ${url}: run \`watcheroni login\`, or set WATCHERONI_API_KEY`);
  }
  return { url, apiKey };
}

// The server URL without trailing slashes, if it's safe to send secrets
// to: the API key goes with every request, and the GitHub tokens with
// sign-in, private-repo subscriptions and refreshes. So https, or plain
// http only to this machine itself, for a server under development.
export function checkServerUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UsageError(`${raw}: the server must be an https URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new UsageError(`${raw}: the server must be an https URL`);
  }
  if (parsed.protocol === "http:" && !isLoopback(parsed.hostname)) {
    throw new UsageError(`${raw}: the server must be https; plain http is only for localhost, 127.0.0.0/8 or [::1]`);
  }
  if (parsed.username || parsed.password) {
    throw new UsageError(`${raw}: the server URL can't hold a user name or password`);
  }
  return raw.replace(/\/+$/, "");
}

// `hostname` as the URL parser leaves it: lowercased, with IPv4 addresses
// in dotted decimal (127.1 and 0x7f.0.0.1 become 127.0.0.1), while a name
// such as 127.0.0.1.nip.io or localhost.evil.com stays a name.
function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "[::1]" || /^127(\.\d+){3}$/.test(hostname);
}

function readJson<T>(file: string): T | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new UsageError(`${file} isn't valid JSON`);
  }
}
