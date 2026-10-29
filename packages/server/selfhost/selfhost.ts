#!/usr/bin/env node
// `npm run selfhost` (or `watcheroni selfhost` in a clone): runs your own
// watcheroni server on your own Cloudflare account, with your own GitHub
// App. See "Self-hosting" in DESIGN.md and packages/server/README.md.
//
//   1. checks `wrangler login`;
//   2. deploys the Worker once without an App, to learn its workers.dev URL;
//   3. creates the GitHub App with GitHub's manifest flow, for that URL;
//   4. converts the App's key to PKCS#8, generates TICKET_KEY and
//      STORAGE_KEY, and sets every secret with `wrangler secret put`;
//   5. deploys again with the App's ID, client ID and slug as vars;
//   6. has you turn on device flow (a manifest can't), and points the CLI
//      at the new server.
//
// The Worker's configuration is wrangler.selfhost.json, made from
// wrangler.jsonc (gitignored, so `git pull` never conflicts with it);
// `npm run selfhost -- --update` remakes it and redeploys. An App created
// by a run that didn't finish is kept in .selfhost-app.json (mode 0600,
// gitignored), and the next run carries on with it.

import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  type AppManifest,
  type NewApp,
  appManifest,
  appSettingsUrl,
  createApp,
  deviceFlowEnabled,
  GITHUB_WEB_URL,
} from "./manifest.ts";
import {
  NO_APP,
  type WorkerVars,
  deployedUrl,
  newKey,
  savedVars,
  selfhostConfig,
  toPkcs8,
  writeCliConfig,
} from "./setup.ts";

export const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG_FILE = "wrangler.selfhost.json";
export const PENDING_FILE = ".selfhost-app.json";

export interface Options {
  name: string;
  org?: string;
  appName?: string;
  public: boolean;
  update: boolean;
}

// An App created by a run that didn't finish, with the keys made for it.
interface Pending {
  app: NewApp;
  ticket_key: string;
  storage_key: string;
}

export interface Deps {
  // Runs wrangler in packages/server. With `input`, it's the command's
  // stdin; `interactive` hands it the terminal. The output is also shown.
  wrangler: (args: string[], o?: { input?: string; interactive?: boolean }) => Promise<{ code: number; output: string }>;
  createApp: (manifestFor: (redirectUrl: string) => AppManifest, org: string | undefined) => Promise<NewApp>;
  deviceFlowEnabled: (clientId: string) => Promise<boolean>;
  // Waits for the person to press Enter.
  pause: (prompt: string) => Promise<void>;
  readFile: (name: string) => string | null;
  // `secret` files are written with mode 0600.
  writeFile: (name: string, text: string, secret?: boolean) => void;
  removeFile: (name: string) => void;
  writeCliConfig: (server: string) => string;
  // The client ID the server's /v1/meta reports, or null.
  serverClientId: (server: string) => Promise<string | null>;
  print: (line: string) => void;
}

export class SelfhostFailed extends Error {}

export async function selfhost(o: Options, deps: Deps): Promise<string> {
  const { print, wrangler } = deps;
  const wranglerJsonc = deps.readFile("wrangler.jsonc");
  if (!wranglerJsonc) throw new SelfhostFailed("run this in packages/server of a watcheroni clone");
  const existing = deps.readFile(CONFIG_FILE);
  const saved = existing ? savedVars(JSON.parse(existing)) : null;
  const pendingText = deps.readFile(PENDING_FILE);
  const pending = pendingText ? (JSON.parse(pendingText) as Pending) : null;
  const name = existing ? String((JSON.parse(existing) as { name?: string }).name ?? o.name) : o.name;

  const writeConfig = (vars: WorkerVars) =>
    deps.writeFile(CONFIG_FILE, `${JSON.stringify(selfhostConfig(wranglerJsonc, name, vars), null, 2)}\n`);
  const deploy = async () => {
    const { code, output } = await wrangler(["deploy", "-c", CONFIG_FILE]);
    if (code !== 0) throw new SelfhostFailed(`wrangler deploy failed (exit ${code})`);
    const url = deployedUrl(output, name);
    if (!url) {
      throw new SelfhostFailed(
        "couldn't find the Worker's workers.dev URL in wrangler's output. On a new Cloudflare account, " +
          "open Workers & Pages in the dashboard once to choose a workers.dev subdomain, then run this again.",
      );
    }
    return url;
  };

  // 1. Cloudflare.
  print("Checking you're signed in to Cloudflare (wrangler whoami)...");
  if (/not authenticated/i.test((await wrangler(["whoami"])).output)) {
    print("Signing in to Cloudflare (wrangler login)...");
    await wrangler(["login"], { interactive: true });
    if (/not authenticated/i.test((await wrangler(["whoami"])).output)) throw new SelfhostFailed("still not signed in to Cloudflare");
  }

  if (o.update) {
    if (!saved) throw new SelfhostFailed(`there's no finished setup to update (${CONFIG_FILE}); run selfhost without --update first`);
    print(`Remaking ${CONFIG_FILE} from wrangler.jsonc and deploying ${name}...`);
    writeConfig(saved);
    const url = await deploy();
    print(`Deployed ${url}.`);
    return url;
  }
  if (saved && !pending) {
    throw new SelfhostFailed(
      `${name} is already set up (${CONFIG_FILE}). To deploy a newer version: npm run selfhost -- --update. ` +
        `To start again with a new App, delete ${CONFIG_FILE}.`,
    );
  }

  // 2. A first deploy, without an App, for the URL. Never over a Worker
  // that's already there: it might be someone's real server.
  if (!existing && !pending) {
    const { code, output } = await wrangler(["deployments", "list", "--name", name, "--json"]);
    if (code === 0) {
      throw new SelfhostFailed(`a Worker called ${name} already exists on this Cloudflare account; choose another with --name`);
    }
    if (!/\b10007\b/.test(output)) throw new SelfhostFailed(`couldn't check whether a Worker called ${name} exists`);
  }
  print(`Deploying the Worker ${name}, so it has a URL for the App...`);
  writeConfig(pending ? appVars(pending.app) : NO_APP);
  const url = await deploy();

  // 3. The GitHub App.
  let state = pending;
  if (state) {
    print(`Carrying on with the GitHub App ${state.app.name} from the last run (${PENDING_FILE}).`);
  } else {
    const appName = o.appName ?? defaultAppName(url);
    print("");
    print(`Creating the GitHub App. In the browser, check the name (${appName} unless you change it;`);
    print("App names are unique across GitHub) and click \"Create GitHub App\".");
    const app = await deps.createApp((redirectUrl) => ({ ...appManifest({ server: url, appName, public: o.public }), redirect_url: redirectUrl }), o.org);
    state = { app, ticket_key: newKey(), storage_key: newKey() };
    // Before anything else can fail: GitHub shows the key only once.
    deps.writeFile(PENDING_FILE, JSON.stringify(state, null, 2), true);
    print(`Created ${app.html_url}.`);
  }
  const { app } = state;

  // 4. Secrets. Values go to wrangler on stdin, never on a command line.
  const secrets: [string, string][] = [
    ["GITHUB_APP_PRIVATE_KEY", toPkcs8(app.pem)],
    ["GITHUB_CLIENT_SECRET", app.client_secret],
    ["GITHUB_WEBHOOK_SECRET", app.webhook_secret],
    ["TICKET_KEY", state.ticket_key],
    ["STORAGE_KEY", state.storage_key],
  ];
  for (const [secret, value] of secrets) {
    print(`Setting ${secret}...`);
    const { code } = await wrangler(["secret", "put", secret, "-c", CONFIG_FILE], { input: value });
    if (code !== 0) throw new SelfhostFailed(`wrangler secret put ${secret} failed (exit ${code}); run selfhost again to carry on`);
  }

  // 5. The App's vars, and the real deploy.
  print(`Deploying ${name} with the App's ID, client ID and slug...`);
  writeConfig(appVars(app));
  await deploy();

  // 6. Device flow, which `watcheroni login` uses.
  while (!(await deps.deviceFlowEnabled(app.client_id))) {
    print("");
    print("One setting can't be made from a manifest. On the App's settings page:");
    print(`  ${appSettingsUrl(app)}`);
    print('tick "Enable Device Flow" and click "Save changes".');
    await deps.pause("Press Enter once it's saved: ");
  }
  deps.removeFile(PENDING_FILE);

  const reported = await deps.serverClientId(url);
  if (reported !== app.client_id) {
    print(`Warning: ${url}/v1/meta reports client ID ${reported ?? "(none)"}, not ${app.client_id}; give it a minute and check again.`);
  }
  const configFile = deps.writeCliConfig(url);
  print("");
  print(`Your server is ${url}, and ${configFile} now points the CLI at it.`);
  print("Next:");
  print(`  1. Install the App on the repositories to watch: ${GITHUB_WEB_URL}/apps/${app.slug}/installations/new`);
  print("  2. npx watcheroni login");
  print("  3. npx watcheroni wait     (in a checkout whose branch has an open PR)");
  print(`Anyone else using this server sets WATCHERONI_SERVER=${url}, or "server" in ~/.config/watcheroni/config.json.`);
  print(`After a git pull, redeploy with: npm run selfhost -- --update`);
  return url;
}

function appVars(app: NewApp): WorkerVars {
  return { GITHUB_APP_ID: String(app.id), GITHUB_CLIENT_ID: app.client_id, GITHUB_APP_SLUG: app.slug };
}

// watcheroni-<workers.dev subdomain>, which is likely to be free and says
// whose it is. GitHub allows 34 characters.
export function defaultAppName(url: string): string {
  const labels = new URL(url).hostname.split(".");
  const sub = labels.length >= 4 ? labels[labels.length - 3] : labels[0];
  return `watcheroni-${sub}`.slice(0, 34).replace(/-+$/, "");
}

// --dry-run: says what each step would do, and changes nothing anywhere.
// Nothing is read from Cloudflare or GitHub, so the URL and App are
// placeholders.
export function dryRunDeps(real: Pick<Deps, "readFile" | "print">): Deps {
  const { print } = real;
  let configName = "";
  const fakeApp: NewApp = {
    id: 123456,
    slug: "watcheroni-example",
    name: "watcheroni-example",
    client_id: "Iv23-example",
    client_secret: "<from GitHub>",
    webhook_secret: "<from GitHub>",
    pem: dryRunKey(),
    html_url: "https://github.com/apps/watcheroni-example",
  };
  return {
    readFile: real.readFile,
    print,
    wrangler: async (args, o) => {
      print(`  [dry run] wrangler ${args.join(" ")}${o?.input !== undefined ? " < (the value, on stdin)" : ""}`);
      if (args[0] === "deployments") return { code: 1, output: "This Worker does not exist on your account. [code: 10007]" };
      if (args[0] === "deploy") return { code: 0, output: `https://${configName}.your-subdomain.workers.dev` };
      return { code: 0, output: "" };
    },
    createApp: async (manifestFor, org) => {
      print(`  [dry run] would open a browser to create this App ${org ? `for the organization ${org}` : "on your account"}:`);
      for (const line of JSON.stringify(manifestFor("http://127.0.0.1:<port>/callback"), null, 2).split("\n")) print(`    ${line}`);
      return fakeApp;
    },
    deviceFlowEnabled: async () => {
      print("  [dry run] would check that device flow is on, and ask you to turn it on if it isn't");
      return true;
    },
    pause: async () => {},
    writeFile: (name, text, secret) => {
      if (name === CONFIG_FILE) configName = (JSON.parse(text) as { name: string }).name;
      if (secret) return print(`  [dry run] would save the new App's details in ${name} (mode 0600) until setup finishes`);
      print(`  [dry run] would write ${name}:`);
      for (const line of text.trimEnd().split("\n")) print(`    ${line}`);
    },
    removeFile: (name) => print(`  [dry run] would remove ${name}`),
    writeCliConfig: (server) => {
      print(`  [dry run] would set "server": "${server}" in the CLI's config.json`);
      return "~/.config/watcheroni/config.json";
    },
    serverClientId: async () => fakeApp.client_id,
  };
}

// A real PKCS#1 key, so the conversion runs too.
function dryRunKey(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}

function realDeps(): Deps {
  const wranglerBin = join(dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), "bin", "wrangler.js");
  const print = (line: string) => console.log(line);
  return {
    print,
    wrangler: (args, o = {}) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [wranglerBin, ...args], {
          cwd: SERVER_DIR,
          stdio: o.interactive ? "inherit" : [o.input === undefined ? "inherit" : "pipe", "pipe", "pipe"],
        });
        let output = "";
        const tee = (to: NodeJS.WriteStream) => (chunk: Buffer) => {
          output += chunk.toString();
          to.write(chunk);
        };
        child.stdout?.on("data", tee(process.stdout));
        child.stderr?.on("data", tee(process.stderr));
        child.stdin?.end(o.input);
        child.on("error", reject);
        child.on("close", (code) => resolve({ code: code ?? 1, output }));
      }),
    createApp: (manifestFor, org) =>
      createApp(manifestFor, org, {
        fetch,
        open: (url) => {
          print(`Opening ${url} in your browser (if it doesn't open, go there yourself)...`);
          openUrl(url);
        },
      }),
    deviceFlowEnabled: (clientId) => deviceFlowEnabled(clientId),
    pause: async (prompt) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      await rl.question(prompt);
      rl.close();
    },
    readFile: (name) => (existsSync(join(SERVER_DIR, name)) ? readFileSync(join(SERVER_DIR, name), "utf8") : null),
    writeFile: (name, text, secret) => writeFileSync(join(SERVER_DIR, name), text, secret ? { mode: 0o600 } : {}),
    removeFile: (name) => rmSync(join(SERVER_DIR, name), { force: true }),
    writeCliConfig: (server) => writeCliConfig(server),
    serverClientId: async (server) => {
      try {
        const meta = (await (await fetch(`${server}/v1/meta`)).json()) as { github?: { client_id?: string } };
        return meta.github?.client_id ?? null;
      } catch {
        return null;
      }
    },
  };
}

function openUrl(url: string): void {
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return;
  const [cmd, ...args] =
    process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["cmd", "/c", "start", "", url]
    : ["xdg-open", url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // They have the URL.
  }
}

const HELP = `npm run selfhost -- [options]   or   watcheroni selfhost [options]   (in a watcheroni clone)

Runs your own watcheroni server on your Cloudflare account (the free plan
is enough), with your own GitHub App, and points the CLI at it.

Options:
  --name NAME       the Worker's name (default watcheroni), which is also
                    the first part of its workers.dev URL
  --org ORG         create the GitHub App for this organization, not your
                    own account
  --app-name NAME   the App's name on GitHub (default watcheroni-<your
                    workers.dev subdomain>); it must be unique on GitHub
  --public          let anyone install the App (by default only its owner)
  --update          after a git pull: remake wrangler.selfhost.json from
                    wrangler.jsonc and deploy
  --dry-run         say what it would do, changing nothing
`;

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      name: { type: "string", default: "watcheroni" },
      org: { type: "string" },
      "app-name": { type: "string" },
      public: { type: "boolean", default: false },
      update: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(values.name)) {
    throw new SelfhostFailed("--name must be lower-case letters, digits and dashes");
  }
  const real = realDeps();
  const deps = values["dry-run"] ? dryRunDeps(real) : real;
  await selfhost(
    { name: values.name, org: values.org, appName: values["app-name"], public: values.public, update: values.update },
    deps,
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`selfhost: ${e instanceof SelfhostFailed || e instanceof TypeError ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      process.exit(1);
    },
  );
}
