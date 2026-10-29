// SessionStart hook (resume, compact): if this session's inbox is
// watching any PRs, remind Claude to keep its `watcheroni wait` running.
// A resumed session has lost its background commands; a compacted one may
// have lost the instructions. Says nothing when nothing is watched, and
// never fails the session start.

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/watcheroni", import.meta.url));

let input = "";
for await (const chunk of process.stdin) input += chunk;
let hook = {};
try {
  hook = JSON.parse(input);
} catch {
  // Fall back to the environment below.
}
const sessionId = hook.session_id ?? process.env.CLAUDE_CODE_SESSION_ID;
if (!sessionId) process.exit(0);
const inbox = `cc-${sessionId}`;

execFile(
  cli,
  ["ls", "--inbox", inbox],
  // npx only from its cache: a registry lookup on every session start is
  // too slow, and with no network it can take minutes. A session that has
  // watched anything through npx has the CLI in that cache.
  // Run from the home directory, not the project: npx would prefer a
  // watcheroni in the project's node_modules, which the project controls.
  { cwd: homedir(), env: { ...process.env, WATCHERONI_NPX_OFFLINE: "1" }, timeout: 15_000 },
  (err, stdout) => {
    // Unread events count too: a wait would print them.
    if (err || !stdout.trim() || /^Inbox \S+ is watching nothing\.$/.test(stdout.trim())) process.exit(0);
    const how = hook.source === "compact"
      ? "If a `watcheroni wait` isn't still running in the background, start one"
      : "Background commands from before the session was resumed have stopped, so start `watcheroni wait` again";
    const context = [
      `watcheroni: this session's inbox, ${inbox}, still has work:`,
      "",
      stdout.trim(),
      "",
      `${how} with run_in_background, and keep the loop going as the watcheroni:watch-pr skill describes. Nothing is lost while no wait runs: the next one reports what changed since the last.`,
    ].join("\n");
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
    }));
  },
);
