#!/usr/bin/env node
// Sets the Claude Code plugin's version to the CLI's (packages/cli), in
// plugin/.claude-plugin/plugin.json and wherever plugin/ names the CLI
// version it runs ("watcheroni@^X.Y.Z", "watcheroni CLI X.Y.Z"). With
// --check, changes nothing and exits 1 if any of them differ.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const check = process.argv.includes("--check");
const version = JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")).version;
const mentions = /(watcheroni@\^|watcheroni CLI )\d+\.\d+\.\d+(?:-[\w.]+)?/g;

const stale = [];
function update(path, next) {
  const text = readFileSync(path, "utf8");
  const updated = next(text);
  if (updated === text) return;
  stale.push(path.slice(root.length + 1));
  if (!check) writeFileSync(path, updated);
}

const manifest = join(root, "plugin/.claude-plugin/plugin.json");
update(manifest, (text) => text.replace(/("version":\s*")[^"]*(")/, `$1${version}$2`));

(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else update(path, (text) => text.replace(mentions, `$1${version}`));
  }
})(join(root, "plugin"));

if (check && stale.length) {
  console.error(`The plugin doesn't match the CLI's version, ${version}, in: ${stale.join(", ")}`);
  console.error("Run `node scripts/plugin-version.mjs` (see RELEASING.md).");
  process.exit(1);
}
for (const path of stale) console.log(`updated ${path}`);
