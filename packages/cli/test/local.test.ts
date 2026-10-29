import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UnsequencedEvent } from "@watcheroni/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { formatText } from "../src/format.ts";
import { GitHubError } from "../src/github.ts";
import { Inbox, InboxBusy } from "../src/inbox.ts";
import { pollOnce } from "../src/poll.ts";
import type { Snapshot } from "../src/snapshot.ts";
import { UsageError, parseTarget, targetKey } from "../src/targets.ts";
import { alice, bob, check, snap } from "./fixtures.ts";

let n = 0;
beforeEach(() => {
  process.env.WATCHERONI_STATE_DIR = mkdtempSync(join(tmpdir(), "watcheroni-test-"));
});
const open = () => Inbox.open(`t${n++}`);

const event = (id: string, kind = "comment.created"): UnsequencedEvent => ({
  v: 1, id, sub: null, kind, at: "t", received_at: "t",
  repo: { id: 1, full_name: "octo/widgets" }, pr: 7, actor: null, data: {}, links: {},
});

describe("targets", () => {
  it("parses short forms and URLs", () => {
    expect(parseTarget("octo/widgets#7")).toEqual({ owner: "octo", name: "widgets", number: 7 });
    expect(parseTarget("https://github.com/octo/widgets/pull/7/files")).toEqual({ owner: "octo", name: "widgets", number: 7 });
    expect(targetKey(parseTarget("octo/my.repo#12"))).toBe("octo/my.repo#12");
  });

  it("explains what it can't do", () => {
    expect(() => parseTarget("octo/widgets")).toThrow(/needs the watcheroni server/);
    expect(() => parseTarget("widgets")).toThrow(UsageError);
  });
});

describe("inbox", () => {
  it("numbers events, drops repeats, and acknowledges", () => {
    const inbox = open();
    expect(inbox.append([event("a"), event("b")]).map((e) => e.seq)).toEqual([1, 2]);
    expect(inbox.append([event("b"), event("c")]).map((e) => e.id)).toEqual(["c"]);
    inbox.ack(2);
    expect(inbox.pending().map((e) => e.seq)).toEqual([3]);
    inbox.close();
  });

  it("keeps events until acknowledged, across processes", () => {
    const name = `t${n++}`;
    const first = Inbox.open(name);
    first.append([event("a")]);
    first.close();
    const second = Inbox.open(name);
    expect(second.pending().map((e) => e.id)).toEqual(["a"]);
    second.close();
  });

  it("is used by one process at a time, and recovers stale locks", () => {
    const name = `t${n++}`;
    const inbox = Inbox.open(name);
    expect(() => Inbox.open(name)).toThrow(InboxBusy);
    inbox.close();
    // A lock left by a process that has gone.
    writeFileSync(join(process.env.WATCHERONI_STATE_DIR!, "inboxes", `${name}.lock`), "999999");
    Inbox.open(name).close();
  });
});

describe("polling", () => {
  const target = { owner: "octo", name: "widgets", number: 7 };

  it("starts quietly, then reports changes, then stops when the PR ends", async () => {
    const inbox = open();
    inbox.watch(targetKey(target), target);
    const snapshots: Snapshot[] = [
      snap({ comments: [{ id: 1, at: "t", url: "u", author: alice }] }),
      snap({ comments: [{ id: 1, at: "t", url: "u", author: alice }, { id: 2, at: "t", url: "u", author: alice }] }),
      snap({ state: "MERGED", mergeSha: "m".repeat(40), comments: [{ id: 1, at: "t", url: "u", author: alice }, { id: 2, at: "t", url: "u", author: alice }] }),
    ];
    const fetch = async () => snapshots.shift()!;
    const log = () => {};
    expect(await pollOnce(inbox, log, fetch)).toEqual([]);
    expect((await pollOnce(inbox, log, fetch)).map((e) => e.kind)).toEqual(["comment.created"]);
    expect((await pollOnce(inbox, log, fetch)).map((e) => e.kind)).toEqual(["pr.merged", "watch.ended"]);
    expect(inbox.watched()).toEqual([]);
    inbox.close();
  });

  it("says at once if the PR has already ended", async () => {
    const inbox = open();
    inbox.watch(targetKey(target), target);
    const events = await pollOnce(inbox, () => {}, async () => snap({ state: "CLOSED" }));
    expect(events.map((e) => [e.kind, e.data.reason])).toEqual([["watch.ended", "closed"]]);
    expect(inbox.watched()).toEqual([]);
    inbox.close();
  });

  it("stops watching a PR that doesn't exist", async () => {
    const inbox = open();
    inbox.watch(targetKey(target), target);
    const messages: string[] = [];
    const missing = async () => { throw new GitHubError("Could not resolve to a PullRequest with the number of 7.", 404); };
    expect(await pollOnce(inbox, (m) => messages.push(m), missing)).toEqual([]);
    expect(messages).toEqual(["octo/widgets#7: no such pull request, or your GitHub login can't see it; no longer watching it"]);
    expect(inbox.watched()).toEqual([]);
    inbox.close();
  });

  it("keeps going when one poll fails", async () => {
    const inbox = open();
    inbox.watch(targetKey(target), target);
    const messages: string[] = [];
    await pollOnce(inbox, (m) => messages.push(m), async () => { throw new Error("502 from GitHub"); });
    expect(messages).toEqual(["octo/widgets#7: 502 from GitHub; trying again next time"]);
    expect(inbox.watched()).toHaveLength(1);
    inbox.close();
  });
});

describe("text output", () => {
  it("gives a command for each pointer and groups a review's comments", async () => {
    const inbox = open();
    const target = { owner: "octo", name: "widgets", number: 7 };
    inbox.watch(targetKey(target), target);
    const before = snap({ checks: [check("lint", { done: false, conclusion: null })] });
    const after = snap({
      checks: [check("lint", { conclusion: "failure" })],
      reviews: [{ id: 10, state: "CHANGES_REQUESTED", empty: false, at: "t", url: "u", author: alice }],
      reviewComments: [
        { id: 20, reviewId: 10, inReplyTo: null, path: "a.ts", line: 3, at: "t", url: "u", author: alice },
        { id: 21, reviewId: 10, inReplyTo: null, path: "b.ts", line: null, at: "t", url: "u", author: alice },
      ],
    });
    const list = [before, after];
    await pollOnce(inbox, () => {}, async () => list.shift()!);
    const events = await pollOnce(inbox, () => {}, async () => list.shift()!);
    expect(formatText(events, ["octo/widgets#7"])).toBe([
      "octo/widgets#7: 6 new events",
      "- review.submitted by alice: changes_requested",
      "  gh api repos/octo/widgets/pulls/7/reviews/10 --jq '.state, .body'",
      "- 2 review comments by alice on a.ts:3, b.ts",
      "  gh api repos/octo/widgets/pulls/7/comments --paginate --jq '.[] | select(.pull_request_review_id == 10) | \"\\(.path):\\(.line // .original_line) \\(.body)\"'",
      "- check.failed: \"lint\" (failure) on 1111111",
      "  gh run view 500 -R octo/widgets --log-failed",
      "- workflow.completed: \"CI\" failure",
      "  gh run view 500 -R octo/widgets --log-failed",
      "- checks.completed on 1111111: failure; failed: lint",
      "  gh pr checks 7 -R octo/widgets",
      "",
      "octo/widgets#7 is still open. Run `watcheroni wait` again to keep watching.",
    ].join("\n"));
    inbox.close();
  });

  it("prints a reply once, and says which thread was resolved", async () => {
    const inbox = open();
    const target = { owner: "octo", name: "widgets", number: 7 };
    inbox.watch(targetKey(target), target);
    const comment = { id: 20, reviewId: 10, inReplyTo: null, path: "a.ts", line: 3, at: "t", url: "u", author: alice };
    const thread = { id: "T1", resolved: false, path: "a.ts", line: 3, commentId: 20 };
    const before = snap({
      reviews: [{ id: 10, state: "COMMENTED", empty: false, at: "t", url: "u", author: alice }],
      reviewComments: [comment],
      threads: [thread],
    });
    // GitHub models the reply as a review with no text holding one comment.
    const after = snap({
      reviews: [...before.reviews, { id: 11, state: "COMMENTED", empty: true, at: "t", url: "u", author: bob }],
      reviewComments: [comment, { ...comment, id: 21, reviewId: 11, inReplyTo: 20, author: bob }],
      threads: [{ ...thread, resolved: true }],
    });
    const list = [before, after];
    await pollOnce(inbox, () => {}, async () => list.shift()!);
    const events = await pollOnce(inbox, () => {}, async () => list.shift()!);
    expect(formatText(events, ["octo/widgets#7"])).toBe([
      "octo/widgets#7: 2 new events",
      "- review_comment.created by bob on a.ts:3 (a reply)",
      "  gh api repos/octo/widgets/pulls/comments/21 --jq .body",
      "- thread.resolved on a.ts:3",
      "  gh api repos/octo/widgets/pulls/comments/20 --jq .body",
      "",
      "octo/widgets#7 is still open. Run `watcheroni wait` again to keep watching.",
    ].join("\n"));
    inbox.close();
  });
});
