import type { WatchEvent } from "@watcheroni/protocol";
import { diff, type LocalKind, unknownRuns } from "./diff.ts";
import { GitHubError, LoginNeeded } from "./github.ts";
import type { Inbox } from "./inbox.ts";
import { fetchSnapshot, type Snapshot } from "./snapshot.ts";

export type Fetch = typeof fetchSnapshot;

// PRs whose unreadable workflow runs this process has warned about.
const unreadableRuns = new Set<string>();

// As if in a new process: for tests.
export function forgetWarnings(): void {
  unreadableRuns.clear();
}

// Polls every PR watched in the inbox once, or those in `only`, saving any
// new events. A PR seen for the first time sets the starting point and
// reports nothing, unless it has already ended. Ended PRs stop being
// watched. PRs a server subscription watches are left to the server,
// unless `all`.
export async function pollOnce(inbox: Inbox, log: (msg: string) => void, fetch: Fetch = fetchSnapshot, all = true, only?: Set<string>): Promise<WatchEvent[]> {
  const added: WatchEvent[] = [];
  inbox.refresh();
  const watched = inbox.watched();
  // A PR no longer watched (unwatched or ended, here or by another
  // process) is forgotten, so watching it again warns again.
  const keys = new Set(watched.map((w) => `${w.target.owner}/${w.target.name}#${w.target.number}`));
  for (const key of unreadableRuns) if (!keys.has(key)) unreadableRuns.delete(key);
  for (const w of watched) {
    if (w.sub && !all) continue;
    const key = `${w.target.owner}/${w.target.name}#${w.target.number}`;
    if (only && !only.has(key)) continue;
    let next: Snapshot;
    try {
      next = await fetch(w.target);
    } catch (e) {
      if (e instanceof LoginNeeded) throw e;
      // Not a hiccup: the PR doesn't exist, or this machine's GitHub login
      // can't see it. Asking again won't change that.
      if (e instanceof GitHubError && e.status === 404) {
        log(`${key}: no such pull request, or your GitHub login can't see it; no longer watching it`);
        inbox.unwatch(key);
        unreadableRuns.delete(key);
        continue;
      }
      log(`${key}: ${(e as Error).message}; trying again next time`);
      continue;
    }
    // Said once per process while workflow runs can't be read (each `wait`
    // is a new process), and once when they can be again, rather than at
    // every poll.
    if (next.workflowRunsError) {
      if (!unreadableRuns.has(key)) {
        unreadableRuns.add(key);
        log(`${key}: can't read its workflow runs (${next.workflowRunsError}); no workflow.completed until they can be read`);
      }
    } else {
      unreadableRuns.delete(key);
    }
    if (!w.snapshot) {
      if (next.state !== "OPEN") {
        const reason = next.state === "MERGED" ? "merged" : "closed";
        added.push(...inbox.record(key, next, [{
          v: 1,
          id: `local:${key}:watch.ended:${reason}`,
          sub: null,
          kind: "watch.ended" satisfies LocalKind,
          at: next.fetchedAt,
          received_at: next.fetchedAt,
          repo: next.repo,
          pr: next.number,
          actor: null,
          data: { reason },
          links: { html: next.url },
        }]));
        inbox.end(key);
        unreadableRuns.delete(key);
      } else {
        inbox.record(key, next, []);
      }
      continue;
    }
    // Workflow runs that couldn't be read this time stay as last read, so
    // a run finishing in between is found once they can be again. On a new
    // head that's none: every run there is new (as diff.ts counts them).
    if (next.workflowRuns === null) {
      next = { ...next, workflowRuns: next.head === w.snapshot.head ? w.snapshot.workflowRuns ?? null : [] };
    }
    // Runs read for the first time on a head after the first poll (a
    // snapshot saved before runs were read, or runs that couldn't be read
    // until now) can't all be compared with the last poll's: said once.
    const unknown = unknownRuns(w.snapshot, next);
    let missed = "";
    if (unknown.length) {
      const ids = unknown.slice(0, 10).map((r) => r.id).join(", ") + (unknown.length > 10 ? `, and ${unknown.length - 10} more` : "");
      missed = unknown.length === 1
        ? `; workflow run ${ids} had already finished, so if it finished since the last poll, no workflow.completed is sent for it`
        : `; workflow runs ${ids} had already finished, so any of them that finished since the last poll gets no workflow.completed`;
    }
    if (w.snapshot.workflowRunsError && !next.workflowRunsError) log(`${key}: its workflow runs can be read again${missed}`);
    else if (missed) log(`${key}: read its workflow runs on this head for the first time${missed}`);
    const events = diff(w.snapshot, next);
    added.push(...inbox.record(key, next, events));
    if (events.some((e) => e.kind === "watch.ended")) {
      inbox.end(key);
      unreadableRuns.delete(key);
    }
  }
  return added;
}
