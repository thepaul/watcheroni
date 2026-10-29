import { execFile, spawn } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";

// The Claude Code plugin (plugin/), as a marketplace install sees it: a
// copy of the plugin directory on its own, with no packages/cli/dist
// beside it. Fake CLIs and a fake npx report how they were run.

const ROOT = join(import.meta.dirname, "..", "..", "..");
const PLUGIN = join(ROOT, "plugin");
const VERSION: string = JSON.parse(readFileSync(join(ROOT, "packages/cli/package.json"), "utf8")).version;

let dir: string;
let installed: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "watcheroni-plugin-"));
  installed = join(dir, "cache", "watcheroni", "watcheroni", VERSION);
  cpSync(PLUGIN, installed, { recursive: true });
  // node on its own, without the npx installed beside it.
  mkdirSync(join(dir, "node"));
  symlinkSync(process.execPath, join(dir, "node", "node"));
});

function script(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

// An executable that prints its name and arguments.
function fake(path: string, name: string): string {
  return script(path, `echo "${name} $*"`);
}

// PATH as Claude Code's Bash tool sees it: the plugin's bin first, then
// `extra`, then node (for the wrapper's `node`) and the system.
function pathWith(...extra: string[]): string {
  return [join(installed, "bin"), ...extra, join(dir, "node"), "/usr/bin", "/bin"].join(":");
}

async function wrapper(env: Record<string, string>, args = ["wait", "--timeout", "1m"]) {
  try {
    const { stdout, stderr } = await promisify(execFile)(join(installed, "bin", "watcheroni"), args, {
      env: { HOME: dir, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

describe("bin/watcheroni", () => {
  it("prefers $WATCHERONI_CLI", async () => {
    const cli = join(dir, "cli.mjs");
    writeFileSync(cli, `console.log("cli " + process.argv.slice(2).join(" "));`);
    fake(join(dir, "global", "watcheroni"), "global");
    fake(join(dir, "npm", "npx"), "npx");
    const r = await wrapper({ PATH: pathWith(join(dir, "global"), join(dir, "npm")), WATCHERONI_CLI: cli });
    expect(r.stdout).toBe("cli wait --timeout 1m\n");
  });

  it("then a watcheroni on PATH, skipping itself", async () => {
    fake(join(dir, "global", "watcheroni"), "global");
    fake(join(dir, "npm", "npx"), "npx");
    const r = await wrapper({ PATH: pathWith(join(dir, "global"), join(dir, "npm")) });
    expect(r.stdout).toBe("global wait --timeout 1m\n");
  });

  it("then the clone's build, when run in place", async () => {
    const clone = join(dir, "clone");
    cpSync(PLUGIN, join(clone, "plugin"), { recursive: true });
    mkdirSync(join(clone, "packages/cli/dist"), { recursive: true });
    writeFileSync(join(clone, "packages/cli/dist/watcheroni.mjs"), `console.log("build");`);
    installed = join(clone, "plugin");
    fake(join(dir, "npm", "npx"), "npx");
    const r = await wrapper({ PATH: pathWith(join(dir, "npm")) });
    expect(r.stdout).toBe("build\n");
  });

  it("then npx, with the CLI version this plugin goes with", async () => {
    fake(join(dir, "npm", "npx"), "npx");
    const r = await wrapper({ PATH: pathWith(join(dir, "npm")) });
    expect(r.stdout).toBe(`npx --yes watcheroni@^${VERSION} wait --timeout 1m\n`);
  });

  it("uses only npx's cache with WATCHERONI_NPX_OFFLINE", async () => {
    fake(join(dir, "npm", "npx"), "npx");
    const r = await wrapper({ PATH: pathWith(join(dir, "npm")), WATCHERONI_NPX_OFFLINE: "1" });
    expect(r.stdout).toBe(`npx --offline --yes watcheroni@^${VERSION} wait --timeout 1m\n`);
  });

  it("exits 127 when there's no CLI", async () => {
    fake(join(dir, "npm", "npx"), "npx");
    const r = await wrapper({ PATH: pathWith(join(dir, "npm")), WATCHERONI_NO_NPX: "1" });
    expect(r.code).toBe(127);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(`npm install -g watcheroni@^${VERSION}`);
  });
});

describe("SessionStart hook", () => {
  function hook(env: Record<string, string>, input: object) {
    return new Promise<{ code: number | null; stdout: string; ms: number }>((resolve) => {
      const started = Date.now();
      const child = spawn(process.execPath, [join(installed, "hooks", "session-start.mjs")], {
        env: { HOME: dir, ...env },
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.on("close", (code) => resolve({ code, stdout, ms: Date.now() - started }));
      child.stdin.end(JSON.stringify(input));
    });
  }

  it("says nothing, quickly, when there's no CLI", async () => {
    const r = await hook({ PATH: pathWith() }, { session_id: "s1", source: "resume" });
    expect(r).toMatchObject({ code: 0, stdout: "" });
    expect(r.ms).toBeLessThan(5000);
  });

  it("runs npx from its cache only", async () => {
    // A fake npx that says the inbox watches a PR when run offline.
    script(
      join(dir, "npm", "npx"),
      `[ "$1 $2 $3" = "--offline --yes watcheroni@^${VERSION}" ] || exit 1\necho "$5 $6: octo/widgets#1 (open)"`,
    );
    const r = await hook({ PATH: pathWith(join(dir, "npm")) }, { session_id: "s1", source: "resume" });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain("--inbox cc-s1: octo/widgets#1 (open)");
  });
});

it("plugin/ matches the CLI's version", async () => {
  const run = promisify(execFile)(process.execPath, [join(ROOT, "scripts/plugin-version.mjs"), "--check"]);
  await expect(run).resolves.toBeDefined();
  const manifest = JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin/plugin.json"), "utf8"));
  expect(manifest.version).toBe(VERSION);
});
