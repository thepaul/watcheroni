// `watcheroni selfhost`: runs packages/server/selfhost/selfhost.ts from the
// watcheroni clone this is run in. The work lives with the server, not in
// this package: it deploys the server's source with the server's wrangler,
// so it needs a clone anyway, and the published CLI stays one small file
// with no dependencies. See "Self-hosting" in DESIGN.md.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { UsageError } from "./targets.ts";

const SCRIPT = join("packages", "server", "selfhost", "selfhost.ts");

// The script in the clone containing `from`, or null.
export function findSelfhost(from: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, SCRIPT))) return join(dir, SCRIPT);
    if (dirname(dir) === dir) return null;
  }
}

export function selfhost(args: string[], cwd = process.cwd()): Promise<number> {
  const script = findSelfhost(cwd);
  if (!script) {
    throw new UsageError(
      "selfhost runs from a clone of watcheroni, which has the server to deploy:\n" +
        "  git clone https://github.com/thepaul/watcheroni && cd watcheroni && npm install\n" +
        "  npm run selfhost",
    );
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: "inherit" });
    child.on("error", () => resolve(1));
    child.on("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}
