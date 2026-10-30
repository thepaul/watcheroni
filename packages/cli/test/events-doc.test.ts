import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HUB_KINDS, WEBHOOK_KINDS } from "../../server/src/kinds.ts";
import { LOCAL_KINDS } from "../src/diff.ts";

// docs/events.md has a `### \`kind\`` section for every kind the server or
// local mode sends, and none for anything else. Each section's
// "**Server:**" and "**Local mode:**" lines start "Not sent" exactly when
// that side doesn't send the kind. The lists are the types the emitting
// code is checked against (server/src/kinds.ts, cli/src/diff.ts).

const DOC = readFileSync(join(import.meta.dirname, "..", "..", "..", "docs", "events.md"), "utf8");
const SERVER = new Set<string>([...WEBHOOK_KINDS, ...HUB_KINDS]);
const LOCAL = new Set<string>(LOCAL_KINDS);

function sections(): Map<string, string> {
  const out = new Map<string, string>();
  const parts = DOC.split(/^(?=#{1,3} )/m);
  for (const part of parts) {
    const m = part.match(/^### `([^`]+)`\n/);
    if (!m) continue;
    expect(out.has(m[1]), `${m[1]} documented twice`).toBe(false);
    out.set(m[1], part);
  }
  return out;
}

function source(section: string, label: string): string {
  const m = section.match(new RegExp(`^\\*\\*${label}:\\*\\* (.+)`, "m"));
  if (!m) throw new Error(`no **${label}:** line`);
  return m[1];
}

describe("docs/events.md", () => {
  it("documents exactly the kinds the server and local mode send", () => {
    const documented = [...sections().keys()].sort();
    expect(documented).toEqual([...new Set([...SERVER, ...LOCAL])].sort());
  });

  it("says which side sends each kind", () => {
    for (const [kind, text] of sections()) {
      expect(source(text, "Server").startsWith("Not sent"), `${kind}: server`).toBe(!SERVER.has(kind));
      expect(source(text, "Local mode").startsWith("Not sent"), `${kind}: local mode`).toBe(!LOCAL.has(kind));
    }
  });
});
