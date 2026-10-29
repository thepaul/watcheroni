import { createPrivateKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AppManifest, NewApp } from "../manifest.ts";
import { NO_APP, selfhostConfig } from "../setup.ts";
import { CONFIG_FILE, type Deps, type Options, PENDING_FILE, SelfhostFailed, WORKER_FILE, defaultAppName, dryRunDeps, selfhost } from "../selfhost.ts";

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
    // The Worker's deployment history on Cloudflare (null: no Worker),
    // shared between runs that pass the same object.
    cloud?: { history: string[] | null };
    // What's typed at --trust-worker's question; null: no terminal.
    answer?: string | null;
    deviceFlowAfter?: number;
    accounts?: { id: string; name: string }[];
  } = {},
) {
  const files: Record<string, string> = { "wrangler.jsonc": WRANGLER_JSONC, ...o.files };
  const wrangler: { args: string[]; input?: string; accountId?: string; config?: Record<string, unknown> }[] = [];
  const manifests: AppManifest[] = [];
  const printed: string[] = [];
  let loggedIn = o.loggedIn ?? true;
  const cloud = o.cloud ?? { history: o.workerExists ? [randomUUID()] : null };
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
        case "deployments": {
          if (!cloud.history) return { code: 1, output: "This Worker does not exist on your account. [code: 10007]" };
          const stdout = JSON.stringify(cloud.history.map((id, i) => ({ created_on: `2026-10-29T00:00:${String(i).padStart(2, "0")}Z`, versions: [{ version_id: id }] })));
          return { code: 0, output: stdout, stdout };
        }
        case "secret":
          (cloud.history ??= []).push(randomUUID());
          return { code: 0, output: "" };
        case "deploy":
          (cloud.history ??= []).push(randomUUID());
          return { code: 0, output: `Uploaded\n  ${URL_}\nCurrent Version ID: ${cloud.history.at(-1)}\n` };
      }
      return { code: 0, output: "" };
    },
    createApp: async (manifestFor) => {
      manifests.push(manifestFor("http://127.0.0.1:1234/callback"));
      return APP;
    },
    deviceFlowEnabled: async () => ++deviceChecks > (o.deviceFlowAfter ?? 0),
    pause: async () => void pauses++,
    ask: async (prompt) => (printed.push(prompt), o.answer ?? null),
    readFile: (name) => files[name] ?? null,
    writeFile: (name, text) => void (files[name] = text),
    removeFile: (name) => void delete files[name],
    writeCliConfig: (server) => ((cliServer = server), "/home/me/.config/watcheroni/config.json"),
    serverClientId: async () => APP.client_id,
    print: (line) => void printed.push(line),
  };
  return { deps, files, cloud, wrangler, manifests, printed, counts: () => ({ deviceChecks, pauses }), cliServer: () => cliServer };
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
      "deployments list --name",
      `deploy -c ${CONFIG_FILE}`,
    ]);
    // The newest version is recorded for --update.
    expect(JSON.parse(f.files[WORKER_FILE])).toEqual({ name: "watcheroni", account_id: ACCOUNT, version_id: f.cloud.history!.at(-1) });
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
    // The first deploy worked, so the resume file says selfhost made the Worker.
    first.deps.wrangler = async (args, o) => (args[0] === "secret" ? { code: 1, output: "" } : real(args, o));
    await expect(selfhost(OPTIONS, first.deps)).rejects.toThrow(SelfhostFailed);
    const pending = JSON.parse(first.files[PENDING_FILE]);
    expect(pending).toMatchObject({ created: true, version_id: first.cloud.history![0], app: { id: 42 } });

    const second = fake({ cloud: first.cloud, files: { [CONFIG_FILE]: first.files[CONFIG_FILE], [PENDING_FILE]: first.files[PENDING_FILE] } });
    await selfhost(OPTIONS, second.deps);
    expect(second.manifests).toEqual([]);
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

    const update = fake({ cloud: done.cloud, files: { [CONFIG_FILE]: config, [WORKER_FILE]: done.files[WORKER_FILE] } });
    await selfhost({ ...OPTIONS, update: true }, update.deps);
    expect(update.wrangler.map((c) => c.args[0])).toEqual(["whoami", "deployments", "deploy"]);
    expect(update.wrangler[2].config).toMatchObject({ name: "watcheroni", vars: { GITHUB_APP_SLUG: "watcheroni-acme" } });
    expect(JSON.parse(update.files[WORKER_FILE]).version_id).toBe(done.cloud.history!.at(-1));

    // A configuration edited to point at another Worker, which has its own
    // history, isn't deployed to.
    const edited = config.replace('"name": "watcheroni"', '"name": "production"');
    const record = update.files[WORKER_FILE].replace('"name": "watcheroni"', '"name": "production"');
    const redirected = fake({ cloud: { history: [randomUUID()] }, files: { [CONFIG_FILE]: edited, [WORKER_FILE]: record } });
    await expect(selfhost({ ...OPTIONS, update: true }, redirected.deps)).rejects.toThrow(/isn't the one selfhost deployed/);
    expect(redirected.wrangler.some((c) => c.args[0] === "deploy")).toBe(false);
    // Or one without the record at all.
    const unrecorded = fake({ cloud: done.cloud, files: { [CONFIG_FILE]: config } });
    await expect(selfhost({ ...OPTIONS, update: true }, unrecorded.deps)).rejects.toThrow(/doesn't confirm/);

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

  it("a first deploy that failed proves nothing: a Worker that appears meanwhile is refused", async () => {
    const cloud: { history: string[] | null } = { history: null };
    const first = fake({ cloud });
    const real = first.deps.wrangler;
    first.deps.wrangler = async (args, o) => (args[0] === "deploy" ? { code: 1, output: "" } : real(args, o));
    await expect(selfhost(OPTIONS, first.deps)).rejects.toThrow(/wrangler deploy failed/);
    expect(JSON.parse(first.files[PENDING_FILE])).toEqual({ name: "watcheroni", account_id: ACCOUNT });

    // Someone else makes a Worker of that name.
    cloud.history = [randomUUID()];
    const second = fake({ cloud, files: { ...first.files } });
    await expect(selfhost(OPTIONS, second.deps)).rejects.toThrow(/first deploy never finished, so it isn't one selfhost made/);
    expect(second.wrangler.some((c) => ["deploy", "secret"].includes(c.args[0]))).toBe(false);
    expect(cloud.history).toHaveLength(1);
  });

  it("refuses to carry on when the recorded version isn't in the Worker's history", async () => {
    const pending = state({ created: true, version_id: randomUUID(), app: APP, ticket_key: "t", storage_key: "s" });
    for (const history of [[randomUUID()], null]) {
      const f = fake({ cloud: { history }, files: { [PENDING_FILE]: pending } });
      await expect(selfhost(OPTIONS, f.deps)).rejects.toThrow(/isn't the one selfhost deployed/);
      expect(f.wrangler.some((c) => ["deploy", "secret"].includes(c.args[0]))).toBe(false);
    }
  });

  it("records a first deploy that worked even when its URL can't be found, so a rerun carries on", async () => {
    const first = fake();
    const real = first.deps.wrangler;
    first.deps.wrangler = async (args, o) => {
      const res = await real(args, o);
      return args[0] === "deploy" ? { ...res, output: res.output.replace(URL_, "") } : res;
    };
    await expect(selfhost(OPTIONS, first.deps)).rejects.toThrow(/workers.dev URL/);
    expect(JSON.parse(first.files[PENDING_FILE])).toMatchObject({ created: true, version_id: first.cloud.history![0] });

    const second = fake({ cloud: first.cloud, files: { ...first.files } });
    expect(await selfhost(OPTIONS, second.deps)).toBe(URL_);
    expect(second.files[PENDING_FILE]).toBeUndefined();
  });

  it("--trust-worker re-records a Worker whose recorded version has left its history, once its name is typed back", async () => {
    const cloud = { history: [randomUUID(), randomUUID()] };
    const pending = state({ created: true, version_id: randomUUID(), app: APP, ticket_key: "t", storage_key: "s" });
    await expect(selfhost(OPTIONS, fake({ cloud, files: { [PENDING_FILE]: pending } }).deps)).rejects.toThrow(/--trust-worker/);

    // No terminal, or the wrong name: nothing changes.
    for (const answer of [null, "watcheroni", ""]) {
      const f = fake({ cloud, answer, files: { [PENDING_FILE]: pending } });
      await expect(selfhost({ ...OPTIONS, trustWorker: true }, f.deps)).rejects.toThrow(answer === null ? /needs a terminal/ : /nothing changed/);
      expect(f.files[PENDING_FILE]).toBe(pending);
    }

    const trust = fake({ cloud, answer: "mine", files: { [PENDING_FILE]: pending } });
    await selfhost({ ...OPTIONS, trustWorker: true }, trust.deps);
    // It showed the deployments, and changed nothing on Cloudflare.
    expect(trust.wrangler.map((c) => c.args.join(" "))).toContain("deployments list --name mine");
    expect(trust.wrangler.some((c) => ["deploy", "secret"].includes(c.args[0]))).toBe(false);
    expect(JSON.parse(trust.files[PENDING_FILE]).version_id).toBe(cloud.history[1]);

    const rerun = fake({ cloud, files: { ...trust.files } });
    expect(await selfhost(OPTIONS, rerun.deps)).toBe(URL_);
  });

  it("--trust-worker works for --update too", async () => {
    const done = fake();
    await selfhost(OPTIONS, done.deps);
    // Ten deployments by hand push the recorded one out.
    done.cloud.history = Array.from({ length: 10 }, () => randomUUID());
    const files = { [CONFIG_FILE]: done.files[CONFIG_FILE], [WORKER_FILE]: done.files[WORKER_FILE] };
    await expect(selfhost({ ...OPTIONS, update: true }, fake({ cloud: done.cloud, files }).deps)).rejects.toThrow(/ten or more/);

    const trust = fake({ cloud: done.cloud, answer: "watcheroni", files: { ...files } });
    await selfhost({ ...OPTIONS, trustWorker: true }, trust.deps);
    expect(JSON.parse(trust.files[WORKER_FILE]).version_id).toBe(done.cloud.history.at(-1));
    await selfhost({ ...OPTIONS, update: true }, fake({ cloud: done.cloud, files: { ...trust.files } }).deps);
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
