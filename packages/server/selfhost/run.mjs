#!/usr/bin/env node
// Runs selfhost.ts, after checking this Node.js can: running TypeScript
// directly (type stripping, on by default) needs 22.18 or later, and an
// older one would fail with a confusing error about the file extension.

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`selfhost: needs Node.js 22.18 or later; this is ${process.versions.node}`);
  process.exit(1);
}

const { main, expected } = await import("./selfhost.ts");
main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(`selfhost: ${expected(e) ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exit(1);
  },
);
