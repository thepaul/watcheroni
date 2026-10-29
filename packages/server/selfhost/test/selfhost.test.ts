import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AppManifest, NewApp } from "../manifest.ts";
import { NO_APP, selfhostConfig } from "../setup.ts";
import { CONFIG_FILE, type Deps, type Options, PENDING_FILE, SelfhostFailed, defaultAppName, dryRunDeps, selfhost } from "../selfhost.ts";

const WRANGLER_JSONC = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
const URL_ = "https://watcheroni.acme.workers.dev";
const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const APP: NewApp = {
  id: 42,
  slug: "watcheroni-acme",
  name: "watcheroni-acme",
  client_id: "Iv23mine",
  client_secret: "client-secret",
  webhook_secret: "webhook-secret",
  pem: PEM,
  html_url: "https://github.com/apps/watcheroni-acme",
};
const OPTIONS: Options = { public: false, update: false };
const ACCOUNT = "acct-1";

// Cloudflare and GitHub stubbed, files in memory.
function fake(
  o: {
    files?: Record<string, string>;
    loggedIn?: boolean;
    workerExists?: boolean;
    deviceFlowAfter?: number;
    accounts?: { id: string; name: string }[];
  } = {},
) {
  const files: Record<string, string> = { "wrangler.jsonc": WRANGLER_JSONC, ...o.files };
  const wrangler: { args: string[]; input?: string; accountId?: string; config?: Record<string, unknown> }[] = [];
  const manifests: AppManifest[] = [];
  const printed: string[] = [];
  let loggedIn = o.loggedIn ?? true;
  let deviceChecks = 0;
  let pauses = 0;
  let cliServer: string | null = null;
  const deps: Deps = {
    wrangler: async (args, opts) => {
      wrangler.push({ args, input: opts?.input, accountId: opts?.accountId, config: args[0] === "deploy" ? JSON.parse(files[CONFIG_FILE]) : undefined });
      switch (args[0]) {
        case "whoami": {
          const stdout = JSON.stringify(loggedIn ? { loggedIn, accounts: o.accounts ?? [{ id: ACCOUNT, name: "Mine" }] } : { loggedIn });
          return { code: loggedIn ? 0 : 1, output: stdout, stdout };
        }
        case "login":
          loggedIn = true;
          return { code: 0, output: "" };
        case "deployments":
          return o.workerExists ? { code: 0, output: "[]" } : { code: 1, output: "This Worker does not exist on your account. [code: 10007]" };
        case "deploy":
          return { code: 0, output: `Uploaded\n  ${URL_}\n` };
      }
      return { code: 0, output: "" };
    },
    createApp: async (manifestFor) => {
      manifests.push(manifestFor("http://127.0.0.1:1234/callback"));
      return APP;
    },
    deviceFlowEnabled: async () => ++deviceChecks > (o.deviceFlowAfter ?? 0),
    pause: async () => void pauses++,
    readFile: (name) => files[name] ?? null,
    writeFile: (name, text) => void (files[name] = text),
    removeFile: (name) => void delete files[name],
    writeCliConfig: (server) => ((cliServer = server), "/home/me/.config/watcheroni/config.json"),
    serverClientId: async () => APP.client_id,
    print: (line) => void printed.push(line),
  };
  return { deps, files, wrangler, manifests, printed, counts: () => ({ deviceChecks, pauses }), cliServer: () => cliServer };
}

describe("selfhost", () => {
  it("deploys, creates the App for the Worker's URL, sets every secret, deploys with its vars, and points the CLI there", async () => {
    const f = fake({ loggedIn: false, deviceFlowAfter: 1 });
    expect(await selfhost(OPTIONS, f.deps)).toBe(URL_);

    expect(f.wrangler.map((c) => c.args.slice(0, 3).join(" "))).toEqual([
      "whoami --json",
      "login",
      "whoami --json",
      "deployments list --name",
      `deploy -c ${CONFIG_FILE}`,
      "secret put GITHUB_APP_PRIVATE_KEY",
      "secret put GITHUB_CLIENT_SECRET",
      "secret put GITHUB_WEBHOOK_SECRET",
      "secret put TICKET_KEY",
      "secret put STORAGE_KEY",
      `deploy -c ${CONFIG_FILE}`,
    ]);
    const [first, last] = f.wrangler.filter((c) => c.args[0] === "deploy");
    expect(first.config!.vars).toEqual({ GITHUB_APP_ID: "", GITHUB_CLIENT_ID: "", GITHUB_APP_SLUG: "" });
    expect(last.config!.vars).toEqual({ GITHUB_APP_ID: "42", GITHUB_CLIENT_ID: "Iv23mine", GITHUB_APP_SLUG: "watcheroni-acme" });
    expect(last.config!.name).toBe("watcheroni");
    // Everything after signing in is pinned to the one account.
    expect(first.config!.account_id).toBe(ACCOUNT);
    expect(f.wrangler.slice(3).every((c) => c.accountId === ACCOUNT)).toBe(true);

    // The App points at the URL the first deploy gave.
    expect(f.manifests[0].hook_attributes.url).toBe(`${URL_}/github/webhook`);
    expect(f.manifests[0].setup_url).toBe(`${URL_}/github/setup`);
    expect(f.manifests[0].redirect_url).toBe("http://127.0.0.1:1234/callback");
    expect(f.manifests[0].name).toBe("watcheroni-acme");

    // Secrets go on stdin, never in the arguments.
    const secrets = Object.fromEntries(f.wrangler.filter((c) => c.args[0] === "secret").map((c) => [c.args[2], c.input!]));
    expect(secrets.GITHUB_APP_PRIVATE_KEY).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(createPrivateKey(secrets.GITHUB_APP_PRIVATE_KEY).export({ type: "pkcs1", format: "pem" })).toBe(PEM);
    expect(secrets.GITHUB_CLIENT_SECRET).toBe("client-secret");
    expect(secrets.GITHUB_WEBHOOK_SECRET).toBe("webhook-secret");
    expect(Buffer.from(secrets.TICKET_KEY, "base64")).toHaveLength(32);
    expect(Buffer.from(secrets.STORAGE_KEY, "base64")).toHaveLength(32);
    expect(secrets.TICKET_KEY).not.toBe(secrets.STORAGE_KEY);
    for (const c of f.wrangler) for (const value of Object.values(secrets)) expect(c.args.join(" ")).not.toContain(value);

    // Device flow was off once, so it asked.
    expect(f.counts()).toEqual({ deviceChecks: 2, pauses: 1 });
    expect(f.printed.join("\n")).toContain("Enable Device Flow");
    expect(f.files[PENDING_FILE]).toBeUndefined();
    expect(f.cliServer()).toBe(URL_);
    expect(f.printed.join("\n")).toContain("https://github.com/apps/watcheroni-acme/installations/new");
  });

  it("won't deploy over a Worker that's already there", async () => {
    const f = fake({ workerExists: true });
    await expect(selfhost(OPTIONS, f.deps)).rejects.toThrow(/already exists/);
    expect(f.wrangler.some((c) => c.args[0] === "deploy")).toBe(false);
  });

  it("carries on with the App from a run that stopped part way, without making another", async () => {
    const first = fake();
    const real = first.deps.wrangler;
    first.deps.wrangler = async (args, o) => (args[0] === "secret" ? { code: 1, output: "" } : real(args, o));
    await expect(selfhost(OPTIONS, first.deps)).rejects.toThrow(SelfhostFailed);
    const pending = JSON.parse(first.files[PENDING_FILE]);
    expect(pending.app.id).toBe(42);

    const second = fake({ files: { [CONFIG_FILE]: first.files[CONFIG_FILE], [PENDING_FILE]: first.files[PENDING_FILE] } });
    await selfhost(OPTIONS, second.deps);
    expect(second.manifests).toEqual([]);
    expect(second.wrangler.some((c) => c.args[0] === "deployments")).toBe(false);
    const secrets = Object.fromEntries(second.wrangler.filter((c) => c.args[0] === "secret").map((c) => [c.args[2], c.input]));
    expect(secrets.TICKET_KEY).toBe(pending.ticket_key);
    expect(secrets.STORAGE_KEY).toBe(pending.storage_key);
    expect(second.files[PENDING_FILE]).toBeUndefined();
  });

  it("--update remakes the configuration and deploys, and a finished setup isn't redone", async () => {
    const done = fake();
    await selfhost(OPTIONS, done.deps);
    const config = done.files[CONFIG_FILE];

    await expect(selfhost(OPTIONS, fake({ files: { [CONFIG_FILE]: config } }).deps)).rejects.toThrow(/already set up/);

    const update = fake({ files: { [CONFIG_FILE]: config } });
    await selfhost({ ...OPTIONS, update: true }, update.deps);
    expect(update.wrangler.map((c) => c.args[0])).toEqual(["whoami", "deploy"]);
    expect(update.wrangler[1].config).toMatchObject({ name: "watcheroni", vars: { GITHUB_APP_SLUG: "watcheroni-acme" } });

    await expect(selfhost({ ...OPTIONS, update: true }, fake().deps)).rejects.toThrow(/no finished setup/);
  });

  it("--dry-run says what it would do and changes nothing", async () => {
    const printed: string[] = [];
    const deps = dryRunDeps({ readFile: (name) => (name === "wrangler.jsonc" ? WRANGLER_JSONC : null), print: (l) => void printed.push(l) });
    await selfhost(OPTIONS, deps);
    const out = printed.join("\n");
    expect(out).toContain("[dry run] CLOUDFLARE_ACCOUNT_ID=your-account-id wrangler deploy -c wrangler.selfhost.json");
    expect(out).toContain(
      "[dry run] CLOUDFLARE_ACCOUNT_ID=your-account-id wrangler secret put GITHUB_APP_PRIVATE_KEY -c wrangler.selfhost.json < (the value, on stdin)",
    );
    expect(out).toContain('"url": "https://watcheroni.your-subdomain.workers.dev/github/webhook"');
    expect(out).toContain('[dry run] would set "server": "https://watcheroni.your-subdomain.workers.dev"');
    expect(out).not.toContain("PRIVATE KEY-----");
  });
});

describe("selfhost keeps to one Worker on one account", () => {
  const state = (o: object = {}) => JSON.stringify({ name: "mine", account_id: ACCOUNT, ...o });

  it("resume file present, config missing, default name: carries on with the recorded Worker", async () => {
    const f = fake({ files: { [PENDING_FILE]: state() } });
    await selfhost(OPTIONS, f.deps);
    const deploys = f.wrangler.filter((c) => c.args[0] === "deploy");
    expect(deploys.map((c) => c.config!.name)).toEqual(["mine", "mine"]);
    // The resume file says this setup made the Worker, so no check; and
    // nothing touched a Worker called watcheroni.
    expect(f.wrangler.some((c) => c.args.includes("watcheroni"))).toBe(false);
    expect(f.files[PENDING_FILE]).toBeUndefined();
  });

  it("refuses a --name that differs from the resume file or the configuration", async () => {
    await expect(selfhost({ ...OPTIONS, name: "watcheroni" }, fake({ files: { [PENDING_FILE]: state() } }).deps)).rejects.toThrow(
      /is for the Worker mine, not watcheroni/,
    );
    const config = JSON.stringify(selfhostConfig(WRANGLER_JSONC, "mine", { GITHUB_APP_ID: "1", GITHUB_CLIENT_ID: "c", GITHUB_APP_SLUG: "s" }, ACCOUNT));
    for (const update of [true, false]) {
      const f = fake({ files: { [CONFIG_FILE]: config } });
      await expect(selfhost({ ...OPTIONS, name: "other", update }, f.deps)).rejects.toThrow(/is for the Worker mine, not other/);
      expect(f.wrangler).toEqual([]);
    }
    // And a resume file and configuration that disagree.
    const f = fake({ files: { [CONFIG_FILE]: config, [PENDING_FILE]: state({ name: "theirs" }) } });
    await expect(selfhost(OPTIONS, f.deps)).rejects.toThrow(/remove the one that's wrong/);
  });

  it("refuses a resume file that doesn't name its Worker and account", async () => {
    const f = fake({ files: { [PENDING_FILE]: JSON.stringify({ app: APP, ticket_key: "t", storage_key: "s" }) } });
    await expect(selfhost(OPTIONS, f.deps)).rejects.toThrow(/isn't safe/);
    expect(f.wrangler).toEqual([]);
  });

  it("runs the check for a configuration without a resume file", async () => {
    const config = JSON.stringify(selfhostConfig(WRANGLER_JSONC, "watcheroni", NO_APP, ACCOUNT));
    const f = fake({ files: { [CONFIG_FILE]: config }, workerExists: true });
    await expect(selfhost(OPTIONS, f.deps)).rejects.toThrow(/already exists/);
    expect(f.wrangler.some((c) => c.args[0] === "deploy")).toBe(false);
  });

  it("needs CLOUDFLARE_ACCOUNT_ID with several accounts, and keeps to the recorded one", async () => {
    const accounts = [{ id: "a1", name: "One" }, { id: "a2", name: "Two" }];
    await expect(selfhost(OPTIONS, fake({ accounts }).deps)).rejects.toThrow(/set CLOUDFLARE_ACCOUNT_ID to one of: a1 \(One\), a2 \(Two\)/);
    await expect(selfhost({ ...OPTIONS, accountId: "a3" }, fake({ accounts }).deps)).rejects.toThrow(/isn't one of your accounts/);

    const chosen = fake({ accounts });
    await selfhost({ ...OPTIONS, accountId: "a2" }, chosen.deps);
    expect(chosen.wrangler.filter((c) => c.args[0] !== "whoami").every((c) => c.accountId === "a2")).toBe(true);

    // The resume file's account is used when none is named, and a
    // different one is refused.
    const resumed = fake({ accounts, files: { [PENDING_FILE]: state({ account_id: "a1" }) } });
    await selfhost(OPTIONS, resumed.deps);
    expect(resumed.wrangler.find((c) => c.args[0] === "deploy")!.accountId).toBe("a1");
    await expect(selfhost({ ...OPTIONS, accountId: "a2" }, fake({ accounts, files: { [PENDING_FILE]: state({ account_id: "a1" }) } }).deps)).rejects.toThrow(
      /is for Cloudflare account a1, not a2/,
    );
  });
});

describe("defaultAppName", () => {
  it("uses the workers.dev subdomain, within GitHub's 34 characters", () => {
    expect(defaultAppName("https://watcheroni.acme.workers.dev")).toBe("watcheroni-acme");
    expect(defaultAppName(`https://w.${"x".repeat(40)}.workers.dev`)).toHaveLength(34);
  });
});
