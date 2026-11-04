import type { WatchEvent } from "@watcheroni/protocol";
import { diff, type LocalKind } from "./diff.ts";
import { GitHubError, LoginNeeded } from "./github.ts";
import type { Inbox } from "./inbox.ts";
import { fetchSnapshot, type Snapshot } from "./snapshot.ts";

export type Fetch = typeof fetchSnapshot;

// Polls every PR watched in the inbox once, or those in `only`, saving any
// new events. A PR seen for the first time sets the starting point and
// reports nothing, unless it has already ended. Ended PRs stop being
// watched. PRs a server subscription watches are left to the server,
// unless `all`.
export async function pollOnce(inbox: Inbox, log: (msg: string) => void, fetch: Fetch = fetchSnapshot, all = true, only?: Set<string>): Promise<WatchEvent[]> {
  const added: WatchEvent[] = [];
  inbox.refresh();
  for (const w of inbox.watched()) {
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
        continue;
      }
      log(`${key}: ${(e as Error).message}; trying again next time`);
      continue;
    }
    // Said when workflow runs stop being readable, and when they're back,
    // rather than at every poll.
    if (next.workflowRunsError && !w.snapshot?.workflowRunsError) {
      log(`${key}: can't read its workflow runs (${next.workflowRunsError}); no workflow.completed until they can be read`);
    } else if (!next.workflowRunsError && w.snapshot?.workflowRunsError) {
      log(`${key}: its workflow runs can be read again`);
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
    const events = diff(w.snapshot, next);
    added.push(...inbox.record(key, next, events));
    if (events.some((e) => e.kind === "watch.ended")) inbox.end(key);
  }
  return added;
}
