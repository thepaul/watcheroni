// The pieces of `selfhost` that don't talk to anything: the App's key in
// the form the Worker wants, generated keys, the Worker's configuration,
// and the CLI's.

import { createPrivateKey, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// GitHub gives the App's key as PKCS#1 ("BEGIN RSA PRIVATE KEY"), which Web
// Crypto in the Worker can't import; it wants PKCS#8.
export function toPkcs8(pem: string): string {
  return createPrivateKey(pem).export({ type: "pkcs8", format: "pem" }).toString();
}

// TICKET_KEY and STORAGE_KEY: 32 random bytes, base64.
export function newKey(): string {
  return randomBytes(32).toString("base64");
}

// wrangler.jsonc as JSON: drops comments and trailing commas, leaving
// strings alone.
export function parseJsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export interface WorkerVars {
  GITHUB_APP_ID: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_APP_SLUG: string;
}

export const NO_APP: WorkerVars = { GITHUB_APP_ID: "", GITHUB_CLIENT_ID: "", GITHUB_APP_SLUG: "" };

type Config = Record<string, unknown> & { env?: Record<string, Record<string, unknown>>; vars?: Record<string, string> };

// The self-hosted Worker's configuration, made from the repository's
// wrangler.jsonc each time so that bindings, migrations and crons added
// later come along. It's the production environment (the real server's
// bindings and crons) over the top level, under the deployer's own name,
// on workers.dev instead of watcheroni.dev, with their App's vars.
// It names the Cloudflare account too, so wrangler can't pick another.
export function selfhostConfig(wranglerJsonc: string, name: string, vars: WorkerVars, accountId: string): Config {
  const { env, ...base } = parseJsonc(wranglerJsonc) as Config;
  const production = env?.production ?? {};
  const config: Config = {
    ...base,
    ...production,
    name,
    account_id: accountId,
    workers_dev: true,
    vars: { ...(production.vars as object), ...vars },
  };
  delete config.routes;
  delete config.route;
  return config;
}

// The App's vars from an earlier run's configuration, if there was one.
export function savedVars(config: Config | null): WorkerVars | null {
  const vars = config?.vars;
  if (!vars?.GITHUB_APP_ID || !vars.GITHUB_CLIENT_ID || !vars.GITHUB_APP_SLUG) return null;
  return { GITHUB_APP_ID: vars.GITHUB_APP_ID, GITHUB_CLIENT_ID: vars.GITHUB_CLIENT_ID, GITHUB_APP_SLUG: vars.GITHUB_APP_SLUG };
}

// The Worker's URL from `wrangler deploy`'s output.
export function deployedUrl(output: string, name: string): string | null {
  const urls = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/gi) ?? [];
  return urls.find((u) => u.startsWith(`https://${name}.`)) ?? urls[0] ?? null;
}

// The same directory the CLI reads (packages/cli/src/config.ts).
export function cliConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.WATCHERONI_CONFIG_DIR) return env.WATCHERONI_CONFIG_DIR;
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "watcheroni");
}

// Points the CLI at the new server, keeping anything else in config.json.
export function writeCliConfig(server: string, dir = cliConfigDir()): string {
  const file = join(dir, "config.json");
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    // Missing or unreadable: start afresh.
  }
  config.server = server;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tmp, file);
  return file;
}
