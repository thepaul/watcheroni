// `npm run selfhost` (or `watcheroni selfhost` in a clone), through
// run.mjs: runs your own watcheroni server on your own Cloudflare account,
// with your own GitHub App. See "Self-hosting" in DESIGN.md and packages/server/README.md.
//
//   1. checks `wrangler login`, and pins one Cloudflare account;
//   2. after checking no Worker of that name exists, deploys the Worker once without an App, to learn its workers.dev URL;
//   3. creates the GitHub App with GitHub's manifest flow, for that URL;
//   4. converts the App's key to PKCS#8, generates TICKET_KEY,
//      API_KEY_SECRET and STORAGE_KEY, and sets every secret with
//      `wrangler secret put`;
//   5. deploys again with the App's ID, client ID and slug as vars;
//   6. has you turn on device flow (a manifest can't), and points the CLI
//      at the new server.
//
// The Worker's configuration is wrangler.selfhost.json, made from
// wrangler.jsonc (gitignored, so `git pull` never conflicts with it);
// `npm run selfhost -- --update` remakes it and redeploys. The Worker's
// name and Cloudflare account, and then the App, are kept in
// .selfhost-app.json (mode 0600, gitignored) until setup finishes, and
// the next run carries on with them.

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
  ManifestFailed,
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
export const WORKER_FILE = ".selfhost-worker.json";

export const DEFAULT_NAME = "watcheroni";

export interface Options {
  // The Worker's name; undefined if --name wasn't given.
  name?: string;
  org?: string;
  appName?: string;
  public: boolean;
  update: boolean;
  // --trust-worker: after confirming at the terminal, record the Worker's
  // newest version as selfhost's own.
  trustWorker?: boolean;
  // CLOUDFLARE_ACCOUNT_ID, which picks the account when there are several.
  accountId?: string;
}

// .selfhost-app.json: written once the check that no Worker of this name
// exists has passed, before the first deploy. After that deploy it says
// `created`, with the newest version ID selfhost made, and a later run
// carries on only if the Worker's deployment history still has that
// version: otherwise the Worker there now isn't the one selfhost made.
// The App and its keys join it once GitHub has made the App, since GitHub
// shows the key only once.
interface State {
  name: string;
  account_id: string;
  created?: boolean;
  version_id?: string;
  app?: NewApp;
  ticket_key?: string;
  api_key_secret?: string;
  storage_key?: string;
}

// .selfhost-worker.json, once setup has finished: the same for --update,
// so an edited wrangler.selfhost.json can't send a deploy to another
// Worker. (Not in wrangler.selfhost.json itself, since wrangler warns
// about fields it doesn't know.)
interface WorkerRecord {
  name: string;
  account_id: string;
  version_id: string;
}

export interface Deps {
  // Runs wrangler in packages/server, on `accountId`'s account if given.
  // With `input`, it's the command's stdin; `interactive` hands it the
  // terminal; `quiet` doesn't show the output. `output` is stdout and
  // stderr together, `stdout` just stdout.
  wrangler: (
    args: string[],
    o?: { input?: string; interactive?: boolean; quiet?: boolean; accountId?: string },
  ) => Promise<{ code: number; output: string; stdout?: string }>;
  createApp: (manifestFor: (redirectUrl: string) => AppManifest, org: string | undefined) => Promise<NewApp>;
  deviceFlowEnabled: (clientId: string) => Promise<boolean>;
  // Waits for the person to press Enter.
  pause: (prompt: string) => Promise<void>;
  // What the person types, or null if there's no terminal to ask at.
  ask: (prompt: string) => Promise<string | null>;
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

interface Whoami {
  loggedIn?: boolean;
  accounts?: { id: string; name: string }[];
}

async function whoami(deps: Deps): Promise<Whoami> {
  const { stdout } = await deps.wrangler(["whoami", "--json"], { quiet: true });
  try {
    return JSON.parse(stdout ?? "") as Whoami;
  } catch {
    return { loggedIn: false };
  }
}

// The Cloudflare account everything happens on, so the check for an
// existing Worker and the deploys can't land on different ones.
function pickAccount(who: Whoami, wanted: string | undefined): string {
  const accounts = who.accounts ?? [];
  const list = accounts.map((a) => `${a.id} (${a.name})`).join(", ");
  if (wanted) {
    if (!accounts.some((a) => a.id === wanted)) throw new SelfhostFailed(`CLOUDFLARE_ACCOUNT_ID ${wanted} isn't one of your accounts: ${list}`);
    return wanted;
  }
  if (accounts.length === 1) return accounts[0].id;
  if (!accounts.length) throw new SelfhostFailed("wrangler doesn't list any Cloudflare accounts for this login");
  throw new SelfhostFailed(`you have several Cloudflare accounts; set CLOUDFLARE_ACCOUNT_ID to one of: ${list}`);
}

export async function selfhost(o: Options, deps: Deps): Promise<string> {
  const { print } = deps;
  const wranglerJsonc = deps.readFile("wrangler.jsonc");
  if (!wranglerJsonc) throw new SelfhostFailed("run this in packages/server of a watcheroni clone");
  const configText = deps.readFile(CONFIG_FILE);
  const config = configText ? (JSON.parse(configText) as { name?: string; account_id?: string }) : null;
  const saved = config ? savedVars(config) : null;
  const stateText = deps.readFile(PENDING_FILE);
  const pending = stateText ? (JSON.parse(stateText) as State) : null;
  if (pending && (!pending.name || !pending.account_id)) {
    throw new SelfhostFailed(`${PENDING_FILE} doesn't say which Worker and account it's for; it isn't safe to carry on from it`);
  }

  // Which Worker. Once a run has chosen, later ones keep to it.
  const name = pending?.name ?? config?.name ?? o.name ?? DEFAULT_NAME;
  const chosenBy = pending ? PENDING_FILE : CONFIG_FILE;
  if (pending && config && config.name !== pending.name) {
    throw new SelfhostFailed(`${PENDING_FILE} is for the Worker ${pending.name} but ${CONFIG_FILE} is for ${config.name}; remove the one that's wrong`);
  }
  if ((pending || config) && o.name && o.name !== name) {
    throw new SelfhostFailed(`${chosenBy} is for the Worker ${name}, not ${o.name}; leave out --name, or remove ${chosenBy} to start again`);
  }

  // 1. Cloudflare.
  print("Checking you're signed in to Cloudflare (wrangler whoami)...");
  let who = await whoami(deps);
  if (!who.loggedIn) {
    print("Signing in to Cloudflare (wrangler login)...");
    await deps.wrangler(["login"], { interactive: true });
    who = await whoami(deps);
    if (!who.loggedIn) throw new SelfhostFailed("still not signed in to Cloudflare");
  }
  const accountId = pickAccount(who, o.accountId ?? pending?.account_id ?? config?.account_id);
  for (const [file, id] of [[PENDING_FILE, pending?.account_id], [CONFIG_FILE, config?.account_id]]) {
    if (id && id !== accountId) throw new SelfhostFailed(`${file} is for Cloudflare account ${id}, not ${accountId}`);
  }
  const wrangler: Deps["wrangler"] = (args, opts) => deps.wrangler(args, { ...opts, accountId });

  const writeConfig = (vars: WorkerVars) =>
    deps.writeFile(CONFIG_FILE, `${JSON.stringify(selfhostConfig(wranglerJsonc, name, vars, accountId), null, 2)}\n`);
  // The Worker's deployment history: the version IDs in it, newest last,
  // or null if there's no such Worker.
  const history = async (): Promise<string[] | null> => {
    const { code, output, stdout } = await wrangler(["deployments", "list", "--name", name, "--json"], { quiet: true });
    if (code !== 0) {
      if (/\b10007\b/.test(output)) return null;
      throw new SelfhostFailed(`couldn't read the deployment history of the Worker ${name}`);
    }
    let list: { created_on?: string; versions?: { version_id?: string }[] }[];
    try {
      list = JSON.parse(stdout ?? "");
    } catch {
      throw new SelfhostFailed(`couldn't read the deployment history of the Worker ${name}`);
    }
    return [...list]
      .sort((a, b) => String(a.created_on).localeCompare(String(b.created_on)))
      .flatMap((d) => (d.versions ?? []).map((v) => String(v.version_id)));
  };
  // Before changing the Worker: is it still the one selfhost deployed?
  const confirm = async (versionId: string, fix: string) => {
    if (!(await history())?.includes(versionId)) {
      throw new SelfhostFailed(
        `the Worker ${name} on Cloudflare account ${accountId} isn't the one selfhost deployed: its deployment history ` +
          `doesn't have version ${versionId}. Either it was deleted and made again, perhaps by someone else, or ten or more ` +
          "deployments were made outside selfhost (deploys by hand, secret changes, rollbacks), which pushes the recorded " +
          "version out of the history Cloudflare shows. If it's yours, `npm run selfhost -- --trust-worker` shows its " +
          `deployments and records the newest after you confirm. ${fix}`,
      );
    }
  };
  const newestVersion = async () => {
    const versions = await history();
    if (!versions?.length) throw new SelfhostFailed(`the Worker ${name} has no deployments`);
    return versions[versions.length - 1];
  };
  // `deployed` records the new version as soon as there is one, before
  // anything else can fail: the Worker exists from then on.
  const deploy = async (deployed: (versionId: string) => void) => {
    const { code, output } = await wrangler(["deploy", "-c", CONFIG_FILE]);
    if (code !== 0) throw new SelfhostFailed(`wrangler deploy failed (exit ${code})`);
    const versionId = /Current Version ID:\s*([0-9a-f-]{36})/i.exec(output)?.[1] ?? (await newestVersion());
    deployed(versionId);
    const url = deployedUrl(output, name);
    if (!url) {
      throw new SelfhostFailed(
        "couldn't find the Worker's workers.dev URL in wrangler's output. On a new Cloudflare account, " +
          "open Workers & Pages in the dashboard once to choose a workers.dev subdomain, then run this again.",
      );
    }
    return url;
  };
  // Values go to wrangler on stdin, never on a command line.
  const putSecret = async (secret: string, value: string) => {
    print(`Setting ${secret}...`);
    const { code } = await wrangler(["secret", "put", secret, "-c", CONFIG_FILE], { input: value });
    if (code !== 0) throw new SelfhostFailed(`wrangler secret put ${secret} failed (exit ${code}); run selfhost again to carry on`);
  };
  const secretNames = async (): Promise<string[]> => {
    const { code, stdout } = await wrangler(["secret", "list", "-c", CONFIG_FILE, "--format", "json"], { quiet: true });
    try {
      if (code !== 0) throw new Error();
      return (JSON.parse(stdout ?? "") as { name?: string }[]).map((s) => String(s.name));
    } catch {
      throw new SelfhostFailed(`couldn't list the secrets of the Worker ${name}`);
    }
  };
  const recordWorker = (versionId: string) =>
    deps.writeFile(WORKER_FILE, `${JSON.stringify({ name, account_id: accountId, version_id: versionId } satisfies WorkerRecord, null, 2)}\n`);

  if (o.trustWorker) {
    // Only for the Worker these files are about, and only by someone at
    // the terminal who has seen its deployments.
    if (pending && !pending.created) {
      throw new SelfhostFailed(
        `selfhost's first deploy of ${name} never finished, so there's no Worker of its to trust. ` +
          `If a Worker called ${name} exists, it isn't one selfhost made: delete that Worker or remove ${PENDING_FILE}.`,
      );
    }
    if (!pending && !saved) throw new SelfhostFailed(`there's no selfhost setup here (${PENDING_FILE} or ${CONFIG_FILE}) to trust a Worker for`);
    // The version recorded is the newest one shown, and nothing may be
    // deployed while the question waits.
    const seen = await history();
    if (!seen?.length) throw new SelfhostFailed(`there's no Worker called ${name} on Cloudflare account ${accountId}`);
    const newest = seen[seen.length - 1];
    print(`The deployments of the Worker ${name} on Cloudflare account ${accountId}:`);
    await wrangler(["deployments", "list", "--name", name]);
    print("If any of these weren't made by you or selfhost, stop here.");
    const answer = await deps.ask(`Type the Worker's name (${name}) to have selfhost treat it as the one it deployed: `);
    if (answer === null) throw new SelfhostFailed("--trust-worker asks for confirmation, so it needs a terminal");
    if (answer.trim() !== name) throw new SelfhostFailed("that isn't the Worker's name; nothing changed");
    if ((await history())?.at(-1) !== newest) {
      throw new SelfhostFailed(`${name} was deployed to while you were reading; nothing changed. Run --trust-worker again to see the new deployment.`);
    }
    if (pending) deps.writeFile(PENDING_FILE, JSON.stringify({ ...pending, created: true, version_id: newest }, null, 2), true);
    else recordWorker(newest);
    print(`Recorded version ${newest}. Run ${pending ? "npm run selfhost" : "npm run selfhost -- --update"} again.`);
    return "";
  }

  if (o.update) {
    if (!saved) throw new SelfhostFailed(`there's no finished setup to update (${CONFIG_FILE}); run selfhost without --update first`);
    const recordText = deps.readFile(WORKER_FILE);
    const record = recordText ? (JSON.parse(recordText) as Partial<WorkerRecord>) : null;
    if (!record?.version_id || record.name !== name || record.account_id !== accountId) {
      throw new SelfhostFailed(
        `${WORKER_FILE} doesn't confirm that ${CONFIG_FILE} is for the Worker selfhost deployed (${name} on account ${accountId}), so it won't deploy`,
      );
    }
    await confirm(record.version_id, `Otherwise check ${CONFIG_FILE}; it won't deploy until that's sorted out.`);
    print(`Remaking ${CONFIG_FILE} from wrangler.jsonc and deploying ${name}...`);
    writeConfig(saved);
    // A server set up before API keys were tagged has no API_KEY_SECRET,
    // and can't sign anyone in until it does.
    if (!(await secretNames()).includes("API_KEY_SECRET")) await putSecret("API_KEY_SECRET", newKey());
    const url = await deploy(recordWorker);
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
  // that's already there, which might be someone's real server, unless
  // the state file says selfhost made it and its history agrees.
  let state: State;
  const saveState = () => deps.writeFile(PENDING_FILE, JSON.stringify(state, null, 2), true);
  if (pending?.created && pending.version_id) {
    state = pending;
    await confirm(pending.version_id, `Otherwise remove ${PENDING_FILE} and choose another --name.`);
  } else {
    if ((await history()) !== null) {
      throw new SelfhostFailed(
        pending
          ? `a Worker called ${name} now exists on Cloudflare account ${accountId}, but selfhost's first deploy never finished, ` +
              `so it isn't one selfhost made. If it's yours to remove, delete that Worker; or remove ${PENDING_FILE} and choose another --name.`
          : `a Worker called ${name} already exists on Cloudflare account ${accountId}; choose another with --name` +
              (config ? ` and delete ${CONFIG_FILE}` : ""),
      );
    }
    state = pending ?? { name, account_id: accountId };
    saveState();
  }
  print(`Deploying the Worker ${name}, so it has a URL for the App...`);
  writeConfig(state.app ? appVars(state.app) : NO_APP);
  const url = await deploy((versionId) => {
    state = { ...state, created: true, version_id: versionId };
    saveState();
  });

  // 3. The GitHub App.
  if (state.app && state.ticket_key && state.storage_key) {
    print(`Carrying on with the GitHub App ${state.app.name} from the last run (${PENDING_FILE}).`);
    // A run from before API keys were tagged didn't make this one.
    if (!state.api_key_secret) {
      state = { ...state, api_key_secret: newKey() };
      saveState();
    }
  } else {
    const appName = o.appName ?? defaultAppName(url);
    print("");
    print(`Creating the GitHub App. In the browser, check the name (${appName} unless you change it;`);
    print("App names are unique across GitHub) and click \"Create GitHub App\".");
    const app = await deps.createApp((redirectUrl) => ({ ...appManifest({ server: url, appName, public: o.public }), redirect_url: redirectUrl }), o.org);
    state = { ...state, app, ticket_key: newKey(), api_key_secret: newKey(), storage_key: newKey() };
    // Before anything else can fail: GitHub shows the key only once.
    saveState();
    print(`Created ${app.html_url}.`);
  }
  const app = state.app!;

  // 4. Secrets.
  const secrets: [string, string][] = [
    ["GITHUB_APP_PRIVATE_KEY", toPkcs8(app.pem)],
    ["GITHUB_CLIENT_SECRET", app.client_secret],
    ["GITHUB_WEBHOOK_SECRET", app.webhook_secret],
    ["TICKET_KEY", state.ticket_key!],
    ["API_KEY_SECRET", state.api_key_secret!],
    ["STORAGE_KEY", state.storage_key!],
  ];
  for (const [secret, value] of secrets) await putSecret(secret, value);
  // Each secret made a new version; remember the newest.
  state = { ...state, version_id: await newestVersion() };
  saveState();

  // 5. The App's vars, and the real deploy.
  print(`Deploying ${name} with the App's ID, client ID and slug...`);
  writeConfig(appVars(app));
  await deploy((versionId) => {
    state = { ...state, version_id: versionId };
    saveState();
    recordWorker(versionId);
  });

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
  const deployed: string[] = [];
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
      const account = o?.accountId ? `CLOUDFLARE_ACCOUNT_ID=${o.accountId} ` : "";
      print(`  [dry run] ${account}wrangler ${args.join(" ")}${o?.input !== undefined ? " < (the value, on stdin)" : ""}`);
      if (args[0] === "whoami") {
        const stdout = JSON.stringify({ loggedIn: true, accounts: [{ id: "your-account-id", name: "your account" }] });
        return { code: 0, output: stdout, stdout };
      }
      if (args[0] === "deployments") {
        // What this dry run has "deployed", or what a finished setup
        // recorded; otherwise no Worker yet.
        const record = JSON.parse(real.readFile(WORKER_FILE) ?? "null") as WorkerRecord | null;
        const ids = deployed.length ? deployed : record?.name === args[3] ? [record.version_id] : [];
        if (!ids.length) return { code: 1, output: "This Worker does not exist on your account. [code: 10007]" };
        const stdout = JSON.stringify(ids.map((id, i) => ({ created_on: String(i), versions: [{ version_id: id }] })));
        return { code: 0, output: stdout, stdout };
      }
      if (args[0] === "secret" && args[1] === "list") {
        return { code: 0, output: "[]", stdout: "[]" };
      }
      if (args[0] === "deploy") {
        deployed.push(`00000000-0000-0000-0000-${String(deployed.length + 1).padStart(12, "0")}`);
        return { code: 0, output: `https://${configName}.your-subdomain.workers.dev\nCurrent Version ID: ${deployed.at(-1)}` };
      }
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
    ask: async (prompt) => {
      print(`  [dry run] would ask: ${prompt}`);
      return null;
    },
    writeFile: (name, text, secret) => {
      if (name === CONFIG_FILE) configName = (JSON.parse(text) as { name: string }).name;
      if (secret) return print(`  [dry run] would save the Worker's name and account${text.includes('"app"') ? ", and the new App's details," : ""} in ${name} (mode 0600) until setup finishes`);
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
          env: o.accountId ? { ...process.env, CLOUDFLARE_ACCOUNT_ID: o.accountId } : process.env,
          stdio: o.interactive ? "inherit" : [o.input === undefined ? "inherit" : "pipe", "pipe", "pipe"],
        });
        let output = "";
        let stdout = "";
        const tee = (to: NodeJS.WriteStream, isStdout: boolean) => (chunk: Buffer) => {
          output += chunk.toString();
          if (isStdout) stdout += chunk.toString();
          if (!o.quiet) to.write(chunk);
        };
        child.stdout?.on("data", tee(process.stdout, true));
        child.stderr?.on("data", tee(process.stderr, false));
        child.stdin?.end(o.input);
        child.on("error", reject);
        child.on("close", (code) => resolve({ code: code ?? 1, output, stdout }));
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
    // Only at a terminal, so a script or a pipe can't answer for someone.
    ask: async (prompt) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(prompt);
      rl.close();
      return answer;
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
                    the first part of its workers.dev URL. Later runs keep
                    to the name the first one chose.
  --org ORG         create the GitHub App for this organization, not your
                    own account
  --app-name NAME   the App's name on GitHub (default watcheroni-<your
                    workers.dev subdomain>); it must be unique on GitHub
  --public          let anyone install the App (by default only its owner)
  --update          after a git pull: remake wrangler.selfhost.json from
                    wrangler.jsonc, add any secret a newer version needs,
                    and deploy
  --trust-worker    when selfhost won't touch the Worker because its
                    deployment history no longer has the version selfhost
                    recorded: shows the deployments and, once you type the
                    Worker's name, records the newest (needs a terminal)
  --dry-run         say what it would do, changing nothing

With several Cloudflare accounts, set CLOUDFLARE_ACCOUNT_ID to choose one.
Needs Node.js 22.18 or later.
`;

// run.mjs runs this, after checking the Node.js version.
export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      name: { type: "string" },
      org: { type: "string" },
      "app-name": { type: "string" },
      public: { type: "boolean", default: false },
      update: { type: "boolean", default: false },
      "trust-worker": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.name !== undefined && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(values.name)) {
    throw new SelfhostFailed("--name must be lower-case letters, digits and dashes");
  }
  const real = realDeps();
  const deps = values["dry-run"] ? dryRunDeps(real) : real;
  await selfhost(
    {
      name: values.name,
      org: values.org,
      appName: values["app-name"],
      public: values.public,
      update: values.update,
      trustWorker: values["trust-worker"],
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID || undefined,
    },
    deps,
  );
  return 0;
}

// The errors that are explained by their message alone.
export function expected(e: unknown): e is Error {
  return (
    e instanceof SelfhostFailed ||
    e instanceof ManifestFailed ||
    (e instanceof TypeError && String((e as { code?: unknown }).code).startsWith("ERR_PARSE_ARGS"))
  );
}
