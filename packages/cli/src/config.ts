import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LoginNeeded } from "./github.ts";
import { UsageError } from "./targets.ts";

// Which server to use, and the API key for it. With no server configured
// the CLI works as before, polling GitHub from this machine.
//
//   ~/.config/watcheroni/config.json        {"server": "https://..."}
//   ~/.config/watcheroni/credentials.json   {"servers": {"https://...": {"api_key": "wk1_..."}}}
//
// WATCHERONI_SERVER and WATCHERONI_API_KEY override both, for CI. An empty
// WATCHERONI_SERVER means local mode whatever config.json says.

export interface ServerConfig {
  url: string;
  apiKey: string;
}

export function configDir(): string {
  if (process.env.WATCHERONI_CONFIG_DIR) return process.env.WATCHERONI_CONFIG_DIR;
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "watcheroni");
}

export function loadServer(): ServerConfig | null {
  const dir = configDir();
  const config = readJson<{ server?: string }>(join(dir, "config.json"));
  const raw = process.env.WATCHERONI_SERVER ?? config?.server ?? "";
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UsageError(`${raw}: the server must be an http or https URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new UsageError(`${raw}: the server must be an http or https URL`);
  }
  const url = raw.replace(/\/+$/, "");
  const credentials = readJson<{ servers?: Record<string, { api_key?: string }> }>(join(dir, "credentials.json"));
  const apiKey = process.env.WATCHERONI_API_KEY || credentials?.servers?.[url]?.api_key;
  if (!apiKey) {
    throw new LoginNeeded(`No API key for ${url}: set WATCHERONI_API_KEY, or add it to ${join(dir, "credentials.json")}`);
  }
  return { url, apiKey };
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
