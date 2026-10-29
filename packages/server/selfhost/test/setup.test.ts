import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NO_APP, cliConfigDir, deployedUrl, newKey, parseJsonc, savedVars, selfhostConfig, toPkcs8, writeCliConfig } from "../setup.ts";

const WRANGLER_JSONC = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
const VARS = { GITHUB_APP_ID: "42", GITHUB_CLIENT_ID: "Iv23mine", GITHUB_APP_SLUG: "watcheroni-acme" };

describe("toPkcs8", () => {
  it("turns GitHub's PKCS#1 key into the same key as PKCS#8", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    expect(pkcs1).toContain("BEGIN RSA PRIVATE KEY");
    const pkcs8 = toPkcs8(pkcs1);
    expect(pkcs8).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    const signature = sign("sha256", Buffer.from("jwt"), createPrivateKey(pkcs8));
    expect(verify("sha256", Buffer.from("jwt"), createPublicKey(privateKey), signature)).toBe(true);
    // Already PKCS#8: unchanged.
    expect(toPkcs8(pkcs8)).toBe(pkcs8);
  });
});

describe("newKey", () => {
  it("is 32 random bytes of base64", () => {
    const a = newKey();
    expect(Buffer.from(a, "base64")).toHaveLength(32);
    expect(newKey()).not.toBe(a);
  });
});

describe("parseJsonc", () => {
  it("drops comments and trailing commas but not what's in strings", () => {
    expect(parseJsonc(`{
      // a comment
      "url": "https://x/*not a comment*/", /* another */
      "s": "a // b \\" c",
      "list": [1, 2,],
    }`)).toEqual({ url: "https://x/*not a comment*/", s: 'a // b " c', list: [1, 2] });
  });
});

describe("selfhostConfig", () => {
  const config = selfhostConfig(WRANGLER_JSONC, "watcheroni", VARS, "acct-1");

  it("is production's shape under the deployer's name, on workers.dev, with their App", () => {
    expect(config.name).toBe("watcheroni");
    expect(config.workers_dev).toBe(true);
    expect(config.account_id).toBe("acct-1");
    expect(config.routes).toBeUndefined();
    expect(config.env).toBeUndefined();
    expect(config.vars).toEqual(VARS);
    expect(config.main).toBe("src/worker.ts");
    // From env.production: the redelivery cron, and every binding.
    const raw = parseJsonc(WRANGLER_JSONC) as { env: { production: Record<string, unknown> }; migrations: unknown };
    expect(config.triggers).toEqual(raw.env.production.triggers);
    expect(config.durable_objects).toEqual(raw.env.production.durable_objects);
    expect(config.migrations).toEqual(raw.migrations);
  });

  it("round-trips the App's vars, and has none before the App exists", () => {
    expect(savedVars(config)).toEqual(VARS);
    expect(savedVars(selfhostConfig(WRANGLER_JSONC, "w", NO_APP, "acct-1"))).toBeNull();
    expect(savedVars(null)).toBeNull();
  });
});

describe("deployedUrl", () => {
  it("finds the Worker's workers.dev URL in wrangler's output", () => {
    const output = `Uploaded watcheroni (3.1 sec)
Deployed watcheroni triggers (0.8 sec)
  https://watcheroni.acme.workers.dev
  schedule: */10 * * * *`;
    expect(deployedUrl(output, "watcheroni")).toBe("https://watcheroni.acme.workers.dev");
    expect(deployedUrl("see https://other.acme.workers.dev and https://mine.acme.workers.dev", "mine")).toBe("https://mine.acme.workers.dev");
    expect(deployedUrl("No workers.dev subdomain", "watcheroni")).toBeNull();
  });
});

describe("writeCliConfig", () => {
  it("sets the server and keeps the rest of config.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "watcheroni-selfhost-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ server: "https://old", other: 1 }));
    const file = writeCliConfig("https://watcheroni.acme.workers.dev", dir);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ server: "https://watcheroni.acme.workers.dev", other: 1 });
  });

  it("creates it if needed, where the CLI looks", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "watcheroni-selfhost-")), "watcheroni");
    expect(cliConfigDir({ XDG_CONFIG_HOME: dir.replace(/\/watcheroni$/, "") })).toBe(dir);
    expect(cliConfigDir({ WATCHERONI_CONFIG_DIR: "/x" })).toBe("/x");
    writeCliConfig("https://s", dir);
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8"))).toEqual({ server: "https://s" });
  });
});
