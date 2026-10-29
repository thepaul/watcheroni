import { DurableObject } from "cloudflare:workers";
import type { Delivery } from "./account";
import { BUCKETS_TABLE, msUntil, take, type BucketSpec } from "./limits";
import { GITHUB_WEB_URL } from "./github";
import { DEFAULT_TTL_SECONDS, matchesKind, type UnsequencedEvent } from "./protocol";

// One per repository, named `repo:<repository.id>`. Knows who watches the
// repo, matches each webhook's events against the subscriptions, and hands
// them to the subscribers' Account objects through an outbox. See
// "RepoHub" in DESIGN.md.

export const REPO_LIMITS = {
  // Webhook deliveries ingested: 600 an hour, bursts of 200. A throttled
  // repo resumes once the bucket is back to `ingestResume` tokens.
  ingest: { capacity: 200, perSecond: 600 / 3600 } satisfies BucketSpec,
  ingestResume: 50,
  subscribe: { capacity: 30, perSecond: 30 / 60 } satisfies BucketSpec,
  subscriptions: 200,
  repoWideSubscriptions: 20,
  accounts: 100,
  // PRs remembered for repo-wide `base` and `author` filters.
  trackedPrs: 1000,
};

// Accounts called straight from `ingest`, and from each alarm run; the
// rest wait for the next alarm. Keeps each invocation well inside the
// subrequest limit.
export const DELIVER_BATCH = 20;
const LEASE_MS = 60_000;
const RETRY_FIRST_MS = 5_000;
const RETRY_MAX_MS = 10 * 60_000;
const GIVE_UP_MS = 24 * 3600_000;
const DELIVERIES_KEPT_MS = 3 * 24 * 3600_000;
const PRUNE_EVERY_MS = 24 * 3600_000;

// Kinds the normaliser produces for RepoHub's own use, never delivered.
// `check.completed` will feed the checks rollup; `pr.seen` carries a PR's
// base, author and state for the `base` and `author` filters.
const INTERNAL_KINDS = new Set(["check.completed", "pr.seen"]);

// 2 added subscriptions.ttl_seconds; 4 added prs.author and prs.seen_at.
// (3 was used by two branches for different things, so 4 checks columns
// rather than trusting the number.)
const SCHEMA_VERSION = 4;
// Retrying an expiry check whose Account couldn't be reached.
const EXPIRY_RETRY_MS = 5 * 60_000;

export interface Ignore {
  self: boolean;
  bots: boolean;
  actors: string[];
}

export interface NewSubscription {
  account: number;
  inbox: string;
  pr: number | null;
  kinds?: string[];
  // Repo-wide only: PRs targeting this branch, or opened by this login.
  base?: string;
  author?: string;
  ignore?: Partial<Ignore>;
  ttl_seconds?: number;
  // Private repos: when access must next be re-checked (ms).
  verified_until?: number | null;
}

// What RepoHub tells an Account when checking whether a subscription has
// gone unread for its whole TTL.
export interface ActivityItem {
  id: string;
  inbox: string;
  created_at: number;
  ttl_ms: number;
}

export interface RepoInfo {
  id: number;
  full_name: string;
  private?: boolean;
}

// The PR's state when the subscription was made, fetched by the caller.
export interface PrBaseline {
  state: "open" | "closed" | "merged";
  head_sha: string | null;
  base_ref?: string | null;
  draft?: boolean;
  mergeable?: "mergeable" | "conflicting" | "unknown";
}

// An open PR, listed by the caller when a repo-wide subscription filters
// on `base` or `author`, so PRs opened before it can match.
export interface OpenPr {
  number: number;
  head_sha: string | null;
  base_ref: string | null;
  author: string | null;
  draft: boolean;
}

export interface Subscription {
  id: string;
  account: number;
  inbox: string;
  pr: number | null;
  kinds: string[];
  base?: string;
  author?: string;
  ignore: Ignore;
  created_at: number;
  expires_at: number;
  verified_until: number | null;
}

export type SubscribeResult =
  // `needs_open_prs`: this made the repo's first `base` or `author`
  // filter, so the caller should list the open PRs for `rememberOpenPrs`.
  | { ok: true; created: boolean; subscription: Subscription; needs_open_prs?: boolean }
  | { ok: false; status: number; code: string; detail: string; retry_after?: number };

export interface IngestResult {
  accepted: boolean;
  reason?: "no_subscriptions" | "duplicate" | "throttled";
  // Events queued for delivery, counted once per inbox.
  events: number;
  // Accounts reached inline, and accounts left to the alarm.
  delivered: number;
  queued: number;
}

export interface RepoHubStats {
  meta: Record<string, string>;
  subscriptions: Subscription[];
  prs: PrRow[];
  outbox: { id: number; account_id: number; attempts: number; next_at: number; items: number }[];
}

type SubRow = {
  id: string;
  account_id: number;
  inbox: string;
  pr: number | null;
  spec: string;
  created_at: number;
  expires_at: number;
  verified_until: number | null;
  // How long it lives unread; null for rows from before schema 2, which
  // all had the default.
  ttl_seconds: number | null;
};

type PrRow = {
  number: number;
  state: string | null;
  draft: number | null;
  head_sha: string | null;
  base_ref: string | null;
  author: string | null;
};

type OutboxRow = {
  id: number;
  account_id: number;
  payload: string;
  attempts: number;
  created_at: number;
};

export class RepoHub extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.migrate();
  }

  // Every step is idempotent: tables are created if missing and columns
  // added if missing, so any earlier version (whatever it meant) ends up
  // with the current schema.
  private migrate(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)");
    const version = Number(this.getMeta("schema_version") ?? 0);
    if (version >= SCHEMA_VERSION) return;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS subscriptions (
          id TEXT PRIMARY KEY,
          account_id INTEGER NOT NULL,
          inbox TEXT NOT NULL,
          pr INTEGER,
          spec TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          verified_until INTEGER,
          ttl_seconds INTEGER
        );
        CREATE INDEX IF NOT EXISTS subscriptions_pr ON subscriptions (pr);
        CREATE TABLE IF NOT EXISTS prs (
          number INTEGER PRIMARY KEY,
          state TEXT, draft INTEGER,
          head_sha TEXT, base_ref TEXT,
          mergeable TEXT,
          mergeable_checked_at INTEGER,
          author TEXT,
          seen_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS prs_head ON prs (head_sha);
        CREATE TABLE IF NOT EXISTS deliveries (guid TEXT PRIMARY KEY, at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS outbox (
          id INTEGER PRIMARY KEY,
          account_id INTEGER NOT NULL,
          payload TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          next_at INTEGER NOT NULL
        );
        ${BUCKETS_TABLE}
      `);
      this.addColumn("subscriptions", "ttl_seconds", "INTEGER");
      this.addColumn("prs", "author", "TEXT");
      this.addColumn("prs", "seen_at", "INTEGER");
      this.refreshTracking();
      this.setMeta("schema_version", String(SCHEMA_VERSION));
    });
  }

  private addColumn(table: string, column: string, type: string): void {
    const has = this.sql.exec("SELECT 1 FROM pragma_table_info(?) WHERE name = ?", table, column).toArray().length;
    if (!has) this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  // The clock, separate so tests can move it.
  protected now(): number {
    return Date.now();
  }

  // ---- RPC: subscriptions --------------------------------------------

  subscribe(sub: NewSubscription, repo: RepoInfo, baseline?: PrBaseline): SubscribeResult {
    const now = this.now();
    const invalid = (detail: string): SubscribeResult => ({ ok: false, status: 400, code: "invalid_request", detail });
    if (!Number.isSafeInteger(sub.account)) return invalid("account must be a GitHub user id");
    if (sub.pr !== null && !(Number.isSafeInteger(sub.pr) && sub.pr > 0)) return invalid("pr must be a PR number or null");
    const kinds = [...new Set(sub.kinds ?? [])].sort();
    if (sub.pr === null && !kinds.length) return invalid("a repository-wide subscription must name at least one kind");
    if (sub.pr !== null && (sub.base !== undefined || sub.author !== undefined)) {
      return invalid("base and author are for repository-wide subscriptions");
    }
    if ((sub.base !== undefined && (typeof sub.base !== "string" || !sub.base)) || (sub.author !== undefined && (typeof sub.author !== "string" || !sub.author))) {
      return invalid("base and author must be non-empty strings");
    }
    if (baseline && baseline.state !== "open") {
      return { ok: false, status: 409, code: "pr_not_open", detail: `PR #${sub.pr} is ${baseline.state}` };
    }

    if (!take(this.sql, "subscribe", REPO_LIMITS.subscribe, now)) {
      const retry = msUntil(this.sql, "subscribe", REPO_LIMITS.subscribe, now, 1);
      return { ok: false, status: 429, code: "rate_limited", detail: "too many subscribe calls for this repository", retry_after: Math.ceil(retry / 1000) };
    }
    this.setMeta("repo_id", String(repo.id));
    this.setMeta("full_name", repo.full_name);
    if (repo.private !== undefined) this.setMeta("private", repo.private ? "1" : "0");

    const ignore: Ignore = {
      self: !!sub.ignore?.self,
      bots: !!sub.ignore?.bots,
      actors: [...new Set(sub.ignore?.actors ?? [])].sort(),
    };
    // Logins are case-insensitive. Left out when unset, so specs from
    // before the filters existed still compare equal.
    const filter = { base: sub.base, author: sub.author?.toLowerCase() };
    const spec = JSON.stringify({ kinds, ignore, ...filter });
    const filtered = filter.base !== undefined || filter.author !== undefined;

    // Idempotent: the same inbox, PR and filter is the same subscription.
    const existing = this.sql
      .exec<SubRow>(
        "SELECT * FROM subscriptions WHERE account_id = ? AND inbox = ? AND pr IS ? AND spec = ?",
        sub.account, sub.inbox, sub.pr, spec,
      )
      .toArray()[0];
    if (existing) {
      // A private repo's access was just checked again.
      if (sub.verified_until && sub.verified_until > (existing.verified_until ?? 0)) {
        this.sql.exec("UPDATE subscriptions SET verified_until = ? WHERE id = ?", sub.verified_until, existing.id);
        existing.verified_until = sub.verified_until;
      }
      return { ok: true, created: false, subscription: toSubscription(existing) };
    }

    const count = (where: string, ...args: SqlStorageValue[]) =>
      this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM subscriptions ${where}`, ...args).one().n;
    const quota = (detail: string): SubscribeResult => ({ ok: false, status: 422, code: "quota_exceeded", detail });
    if (count("") >= REPO_LIMITS.subscriptions) return quota("subscriptions on this repository");
    if (sub.pr === null && count("WHERE pr IS NULL") >= REPO_LIMITS.repoWideSubscriptions) {
      return quota("repository-wide subscriptions on this repository");
    }
    if (
      !count("WHERE account_id = ?", sub.account) &&
      this.sql.exec<{ n: number }>("SELECT COUNT(DISTINCT account_id) AS n FROM subscriptions").one().n >= REPO_LIMITS.accounts
    ) {
      return quota("accounts watching this repository");
    }

    const row: SubRow = {
      id: `sub_${ulid(now)}`,
      account_id: sub.account,
      inbox: sub.inbox,
      pr: sub.pr,
      spec,
      created_at: now,
      expires_at: now + (sub.ttl_seconds ?? DEFAULT_TTL_SECONDS) * 1000,
      verified_until: sub.verified_until ?? null,
      ttl_seconds: sub.ttl_seconds ?? null,
    };
    this.sql.exec(
      "INSERT INTO subscriptions (id, account_id, inbox, pr, spec, created_at, expires_at, verified_until, ttl_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      row.id, row.account_id, row.inbox, row.pr, row.spec, row.created_at, row.expires_at, row.verified_until, row.ttl_seconds,
    );
    if (sub.pr !== null) {
      this.sql.exec("INSERT OR IGNORE INTO prs (number) VALUES (?)", sub.pr);
      if (baseline) {
        this.sql.exec(
          "UPDATE prs SET state = ?, draft = ?, head_sha = ?, base_ref = ?, mergeable = ?, mergeable_checked_at = ? WHERE number = ?",
          baseline.state, baseline.draft ? 1 : 0, baseline.head_sha, baseline.base_ref ?? null,
          baseline.mergeable ?? null, baseline.mergeable ? now : null, sub.pr,
        );
      }
    }
    const startsTracking = filtered && !this.tracksAllPrs();
    if (startsTracking) this.setMeta("tracks_all_prs", "1");
    this.scheduleAlarm();
    return { ok: true, created: true, subscription: toSubscription(row), ...(startsTracking ? { needs_open_prs: true } : {}) };
  }

  // RPC: a private repo's access was checked again (POST .../verify).
  // Null if there's no such subscription.
  reverify(subId: string, until: number): Subscription | null {
    this.sql.exec("UPDATE subscriptions SET verified_until = MAX(COALESCE(verified_until, 0), ?) WHERE id = ?", until, subId);
    const row = this.sql.exec<SubRow>("SELECT * FROM subscriptions WHERE id = ?", subId).toArray()[0];
    this.scheduleAlarm();
    return row ? toSubscription(row) : null;
  }

  // RPC: ends one subscription with a final `kind` event, e.g.
  // `watch.unverified` when its user turns out to have lost access.
  async endSubscription(subId: string, kind: string, reason: string): Promise<boolean> {
    const row = this.sql.exec<SubRow>("SELECT * FROM subscriptions WHERE id = ?", subId).toArray()[0];
    if (!row) return false;
    const now = this.now();
    const outgoing: Map<number, Delivery[]> = new Map();
    this.endWith([row], kind, reason, kind, now, outgoing);
    const ids = this.enqueue(outgoing, now);
    await this.deliverRows(ids, now);
    this.scheduleAlarm();
    return true;
  }

  unsubscribe(subId: string): boolean {
    const row = this.sql.exec<SubRow>("SELECT * FROM subscriptions WHERE id = ?", subId).toArray()[0];
    if (!row) return false;
    this.sql.exec("DELETE FROM subscriptions WHERE id = ?", subId);
    if (row.pr !== null) this.forgetPrIfUnwatched(row.pr);
    else this.refreshTracking();
    return true;
  }

  // Ends every watch on the repo with `watch.revoked`: the App was
  // uninstalled or suspended, or the repo removed from it. `eventBase`
  // (the webhook's delivery ID) makes the events' IDs stable across
  // retries. Returns how many subscriptions ended.
  async revokeAll(reason: string, eventBase: string): Promise<number> {
    const rows = this.sql.exec<SubRow>("SELECT * FROM subscriptions ORDER BY rowid").toArray();
    if (!rows.length) return 0;
    const now = this.now();
    const outgoing: Map<number, Delivery[]> = new Map();
    this.endWith(rows, "watch.revoked", reason, `${eventBase}.revoked`, now, outgoing);
    this.sql.exec("DELETE FROM prs");
    this.deleteMeta("tracks_all_prs");
    const ids = this.enqueue(outgoing, now);
    await this.deliverRows(ids, now);
    this.scheduleAlarm();
    return rows.length;
  }

  // Queues a final `kind` event for each subscription and forgets them.
  // Event IDs are `${idBase}.${sub id}`, stable across retries.
  private endWith(rows: SubRow[], kind: string, reason: string, idBase: string, now: number, outgoing: Map<number, Delivery[]>): void {
    const at = new Date(now).toISOString();
    const repo = { id: Number(this.getMeta("repo_id")), full_name: this.getMeta("full_name") ?? "" };
    for (const row of rows) {
      push(outgoing, row.account_id, {
        inbox: row.inbox,
        event: {
          v: 1,
          id: `${idBase}.${row.id}`,
          sub: row.id,
          kind,
          at,
          received_at: at,
          repo,
          pr: row.pr,
          actor: null,
          data: { reason },
          links: row.pr === null ? {} : { html: `${GITHUB_WEB_URL}/${repo.full_name}/pull/${row.pr}` },
        },
      });
      this.sql.exec("DELETE FROM subscriptions WHERE id = ?", row.id);
      if (row.pr !== null) this.forgetPrIfUnwatched(row.pr);
    }
    if (rows.some((r) => r.pr === null)) this.refreshTracking();
  }

  // Subscriptions past `verified_until` end with `watch.unverified`. Those
  // past `expires_at` are checked with their Account first: reading the
  // inbox (or being connected to it) since restarts the clock, and only
  // an inbox nobody has read for the whole TTL ends with `watch.expired`.
  private async expireDue(now: number, outgoing: Map<number, Delivery[]>): Promise<void> {
    const due = this.sql
      .exec<SubRow>("SELECT * FROM subscriptions WHERE expires_at <= ? OR verified_until <= ? ORDER BY rowid", now, now)
      .toArray();
    if (!due.length) return;
    const unverified = due.filter((r) => r.verified_until !== null && r.verified_until <= now);
    this.endWith(unverified, "watch.unverified", "not_verified", "unverified", now, outgoing);

    const byAccount: Map<number, SubRow[]> = new Map();
    for (const row of due) {
      if (unverified.includes(row)) continue;
      const list = byAccount.get(row.account_id);
      if (list) list.push(row);
      else byAccount.set(row.account_id, [row]);
    }
    for (const [account, rows] of [...byAccount].slice(0, DELIVER_BATCH)) {
      let until: Record<string, number>;
      try {
        until = await this.subscriptionActivity(account, rows.map((r) => ({
          id: r.id,
          inbox: r.inbox,
          created_at: r.created_at,
          ttl_ms: (r.ttl_seconds ?? DEFAULT_TTL_SECONDS) * 1000,
        })));
      } catch (e) {
        console.error(`expiry check for account ${account} failed`, e);
        for (const r of rows) this.sql.exec("UPDATE subscriptions SET expires_at = ? WHERE id = ?", now + EXPIRY_RETRY_MS, r.id);
        continue;
      }
      const expired: SubRow[] = [];
      for (const r of rows) {
        const next = until[r.id];
        if (next !== undefined && next > now) this.sql.exec("UPDATE subscriptions SET expires_at = ? WHERE id = ?", next, r.id);
        else expired.push(r);
      }
      this.endWith(expired, "watch.expired", "unread", "expired", now, outgoing);
    }
  }

  // Separate so tests can stand in for the Account.
  protected async subscriptionActivity(account: number, items: ActivityItem[]): Promise<Record<string, number>> {
    const stub = this.env.ACCOUNT.get(this.env.ACCOUNT.idFromName(`acct:${account}`));
    return stub.subscriptionActivity(items);
  }

  stats(): RepoHubStats {
    const meta = Object.fromEntries(
      this.sql.exec<{ k: string; v: string }>("SELECT k, v FROM meta").toArray().map((r) => [r.k, r.v]),
    );
    const subscriptions = this.sql
      .exec<SubRow>("SELECT * FROM subscriptions ORDER BY rowid")
      .toArray()
      .map(toSubscription);
    const prs = this.sql.exec<PrRow>("SELECT number, state, draft, head_sha, base_ref, author FROM prs ORDER BY number").toArray();
    const outbox = this.sql
      .exec<OutboxRow & { next_at: number }>("SELECT * FROM outbox ORDER BY id")
      .toArray()
      .map((r) => ({
        id: r.id,
        account_id: r.account_id,
        attempts: r.attempts,
        next_at: r.next_at,
        items: (JSON.parse(r.payload) as unknown[]).length,
      }));
    return { meta, subscriptions, prs, outbox };
  }

  // ---- RPC: ingest ---------------------------------------------------

  // One call per webhook delivery, with the normaliser's events.
  async ingest(delivery: string, facts: UnsequencedEvent[]): Promise<IngestResult> {
    const result: IngestResult = { accepted: false, events: 0, delivered: 0, queued: 0 };
    // 1. An unwatched repo costs no writes and never touches a bucket.
    if (!this.sql.exec("SELECT 1 FROM subscriptions LIMIT 1").toArray().length) {
      return { ...result, reason: "no_subscriptions" };
    }
    const now = this.now();
    const repo = facts.find((f) => f.repo)?.repo;
    if (repo) {
      this.setMeta("repo_id", String(repo.id));
      this.setMeta("full_name", repo.full_name);
    }

    // 2. GitHub redelivers with the same GUID.
    if (this.sql.exec("SELECT 1 FROM deliveries WHERE guid = ?", delivery).toArray().length) {
      return { ...result, reason: "duplicate" };
    }
    this.sql.exec("INSERT INTO deliveries (guid, at) VALUES (?, ?)", delivery, now);
    if (!this.getMeta("prune_at")) this.setMeta("prune_at", String(now + PRUNE_EVERY_MS));

    // 3. The repo's ingest limit.
    const outgoing: Map<number, Delivery[]> = new Map();
    this.endThrottleIfDue(now, outgoing);
    if (this.throttledUntil() !== null || !take(this.sql, "ingest", REPO_LIMITS.ingest, now)) {
      this.throttle(now, outgoing);
      const ids = this.enqueue(outgoing, now);
      result.events = countItems(outgoing);
      Object.assign(result, await this.deliverRows(ids, now));
      this.scheduleAlarm();
      return { ...result, reason: "throttled" };
    }

    // 4. Update what's known about watched PRs, and give events that carry
    // only a head SHA (statuses, checks on branches) the PRs at that head.
    const events: UnsequencedEvent[] = [];
    const tracking = this.tracksAllPrs();
    for (const fact of facts) {
      this.updatePr(fact, tracking);
      events.push(...this.withPrs(fact));
    }

    // 5. Match, ending watches on PRs that merged or closed.
    const ended = events.filter((e) => e.pr !== null && (e.kind === "pr.merged" || e.kind === "pr.closed"));
    for (const e of ended) {
      events.push({
        v: 1,
        id: `${e.id}.ended`,
        sub: null,
        kind: "watch.ended",
        at: e.at,
        received_at: e.received_at,
        repo: e.repo,
        pr: e.pr,
        actor: null,
        data: { reason: e.kind === "pr.merged" ? "merged" : "closed" },
        links: e.links,
      });
    }
    this.match(events.filter((e) => !INTERNAL_KINDS.has(e.kind)), outgoing);
    for (const e of ended) {
      this.sql.exec("DELETE FROM subscriptions WHERE pr = ?", e.pr);
      this.forgetPrIfUnwatched(e.pr!);
    }

    // 6. Outbox first, then deliver what fits inline.
    const ids = this.enqueue(outgoing, now);
    result.accepted = true;
    result.events = countItems(outgoing);
    Object.assign(result, await this.deliverRows(ids, now));
    this.scheduleAlarm();
    return result;
  }

  // ---- Alarm ---------------------------------------------------------

  override async alarm(): Promise<void> {
    const now = this.now();
    const outgoing: Map<number, Delivery[]> = new Map();
    this.endThrottleIfDue(now, outgoing);
    await this.expireDue(now, outgoing);
    const fresh = this.enqueue(outgoing, now);

    const pruneAt = Number(this.getMeta("prune_at") ?? 0);
    if (pruneAt && pruneAt <= now) {
      this.sql.exec("DELETE FROM deliveries WHERE at < ?", now - DELIVERIES_KEPT_MS);
      const left = this.sql.exec("SELECT 1 FROM deliveries LIMIT 1").toArray().length;
      if (left) this.setMeta("prune_at", String(now + PRUNE_EVERY_MS));
      else this.deleteMeta("prune_at");
    }

    const due = this.sql
      .exec<{ id: number }>("SELECT id FROM outbox WHERE next_at <= ? ORDER BY next_at, id LIMIT ?", now, DELIVER_BATCH)
      .toArray()
      .map((r) => r.id);
    await this.deliverRows([...new Set([...fresh, ...due])].slice(0, DELIVER_BATCH), now);
    this.scheduleAlarm();
  }

  // ---- Matching ------------------------------------------------------

  // `tracking`: a repo-wide subscription filters on base or author, so
  // every open PR is remembered, not just watched ones.
  private updatePr(e: UnsequencedEvent, tracking: boolean): void {
    if (e.pr === null || !e.kind.startsWith("pr.")) return;
    const d = e.data;
    const opens = e.kind === "pr.opened" || e.kind === "pr.reopened" || (e.kind === "pr.seen" && d.state === "open");
    const now = this.now();
    if (tracking && opens) this.trackPr(e.pr, now);
    switch (e.kind) {
      case "pr.seen": {
        // Fills gaps only: deliveries can arrive out of order, and the head
        // and base move only with `pr.pushed` and `pr.base_changed`. Most
        // PR webhooks carry one, so a row with nothing to fill isn't
        // written at all.
        const [head, base, author, state] = [str(d.head_sha), str(d.base), str(d.author), str(d.state)];
        this.sql.exec(
          `UPDATE prs SET head_sha = COALESCE(head_sha, ?1), base_ref = COALESCE(base_ref, ?2), author = COALESCE(author, ?3),
             state = COALESCE(state, ?4), seen_at = ?5
           WHERE number = ?6 AND ((head_sha IS NULL AND ?1 IS NOT NULL) OR (base_ref IS NULL AND ?2 IS NOT NULL)
             OR (author IS NULL AND ?3 IS NOT NULL) OR (state IS NULL AND ?4 IS NOT NULL))`,
          head, base, author, state, now, e.pr,
        );
        break;
      }
      case "pr.opened":
        this.sql.exec(
          "UPDATE prs SET state = 'open', draft = ?, head_sha = ?, base_ref = ?, seen_at = ? WHERE number = ?",
          d.draft ? 1 : 0, str(d.head_sha), str(d.base), now, e.pr,
        );
        break;
      case "pr.pushed":
        if (str(d.after)) this.sql.exec("UPDATE prs SET head_sha = ?, seen_at = ? WHERE number = ?", str(d.after), now, e.pr);
        break;
      case "pr.reopened":
        this.sql.exec("UPDATE prs SET state = 'open', seen_at = ? WHERE number = ?", now, e.pr);
        break;
      case "pr.ready_for_review":
      case "pr.converted_to_draft":
        this.sql.exec("UPDATE prs SET draft = ? WHERE number = ?", e.kind === "pr.converted_to_draft" ? 1 : 0, e.pr);
        break;
      case "pr.base_changed":
        this.sql.exec("UPDATE prs SET base_ref = ? WHERE number = ?", str(d.to), e.pr);
        break;
      case "pr.merged":
      case "pr.closed":
        this.sql.exec("UPDATE prs SET state = ? WHERE number = ?", e.kind.slice(3), e.pr);
        break;
    }
  }

  // An event with no PR but a head SHA becomes one event per watched PR at
  // that head. Each copy gets its own stable ID.
  private withPrs(e: UnsequencedEvent): UnsequencedEvent[] {
    const sha = str(e.data.head_sha);
    if (e.pr !== null || !sha) return [e];
    const prs = this.sql.exec<{ number: number }>("SELECT number FROM prs WHERE head_sha = ? ORDER BY number", sha).toArray();
    if (!prs.length) return [e];
    return prs.map(({ number }) => ({ ...e, id: `${e.id}.pr${number}`, pr: number }));
  }

  // Groups matching events by account. An event goes to each inbox once,
  // naming the first subscription in that inbox that matched.
  private match(events: UnsequencedEvent[], out: Map<number, Delivery[]>): void {
    if (!events.length) return;
    const prs = [...new Set(events.map((e) => e.pr).filter((n) => n !== null))];
    const subs = this.sql
      .exec<SubRow>(
        "SELECT * FROM subscriptions WHERE pr IS NULL OR pr IN (SELECT value FROM json_each(?)) ORDER BY rowid",
        JSON.stringify(prs),
      )
      .toArray()
      .map(toSubscription);
    // What's known of each PR, for repo-wide `base` and `author` filters.
    const known = subs.some((s) => s.base !== undefined || s.author !== undefined)
      ? new Map(this.sql
        .exec<PrRow>("SELECT * FROM prs WHERE number IN (SELECT value FROM json_each(?))", JSON.stringify(prs))
        .toArray()
        .map((r) => [r.number, r]))
      : new Map<number, PrRow>();
    for (const event of events) {
      const inboxes = new Set<string>();
      for (const sub of subs) {
        if (sub.pr === null ? event.kind.startsWith("watch.") : sub.pr !== event.pr) continue;
        if (sub.pr === null && !filterMatches(sub, event.pr === null ? undefined : known.get(event.pr))) continue;
        if (!matchesKind(sub.kinds, event.kind) || ignored(sub, event)) continue;
        const key = `${sub.account}\u0000${sub.inbox}`;
        if (inboxes.has(key)) continue;
        inboxes.add(key);
        push(out, sub.account, { inbox: sub.inbox, event: { ...event, sub: sub.id } });
      }
    }
  }

  // ---- Throttling ----------------------------------------------------

  private throttledUntil(): number | null {
    const v = this.getMeta("throttled_until");
    return v === null ? null : Number(v);
  }

  // Drops this delivery. The first drop tells every inbox once.
  private throttle(now: number, out: Map<number, Delivery[]>): void {
    if (this.throttledUntil() !== null) {
      this.setMeta("dropped", String(Number(this.getMeta("dropped") ?? 0) + 1));
      return;
    }
    const until = now + msUntil(this.sql, "ingest", REPO_LIMITS.ingest, now, REPO_LIMITS.ingestResume);
    this.setMeta("throttled_at", String(now));
    this.setMeta("throttled_until", String(until));
    this.setMeta("dropped", "1");
    this.toEveryInbox(out, "throttled", now, { until: new Date(until).toISOString() });
  }

  private endThrottleIfDue(now: number, out: Map<number, Delivery[]>): void {
    const until = this.throttledUntil();
    if (until === null || until > now) return;
    this.toEveryInbox(out, "unthrottled", now, { dropped: Number(this.getMeta("dropped") ?? 0) });
    for (const k of ["throttled_at", "throttled_until", "dropped"]) this.deleteMeta(k);
  }

  // `repo.*` events go to every inbox watching the repo, whatever its kinds.
  private toEveryInbox(out: Map<number, Delivery[]>, what: "throttled" | "unthrottled", now: number, data: UnsequencedEvent["data"]): void {
    const at = new Date(now).toISOString();
    const repoId = Number(this.getMeta("repo_id"));
    const since = this.getMeta("throttled_at");
    const first = this.sql
      .exec<{ id: string; account_id: number; inbox: string }>(
        "SELECT id, account_id, inbox FROM subscriptions s WHERE id = (SELECT id FROM subscriptions WHERE account_id = s.account_id AND inbox = s.inbox ORDER BY rowid LIMIT 1) ORDER BY rowid",
      )
      .toArray();
    for (const sub of first) {
      push(out, sub.account_id, {
        inbox: sub.inbox,
        event: {
          v: 1,
          id: `repo:${repoId}.${what}.${since}`,
          sub: sub.id,
          kind: `repo.${what}`,
          at,
          received_at: at,
          repo: { id: repoId, full_name: this.getMeta("full_name") ?? "" },
          pr: null,
          actor: null,
          data,
          links: {},
        },
      });
    }
  }

  // ---- Outbox --------------------------------------------------------

  // One row per account. The first DELIVER_BATCH rows are leased for
  // inline delivery; the rest are due at once, for the alarm.
  private enqueue(out: Map<number, Delivery[]>, now: number): number[] {
    const ids: number[] = [];
    for (const [account, items] of out) {
      const nextAt = ids.length < DELIVER_BATCH ? now + LEASE_MS : now;
      const { id } = this.sql
        .exec<{ id: number }>(
          "INSERT INTO outbox (account_id, payload, created_at, next_at) VALUES (?, ?, ?, ?) RETURNING id",
          account, JSON.stringify(items), now, nextAt,
        )
        .one();
      ids.push(id);
    }
    return ids;
  }

  // Delivers up to DELIVER_BATCH rows in parallel. Rows that fail are
  // retried with backoff.
  private async deliverRows(ids: number[], now: number): Promise<{ delivered: number; queued: number }> {
    const batch = ids.slice(0, DELIVER_BATCH);
    const rows = batch.flatMap((id) => this.sql.exec<OutboxRow>("SELECT * FROM outbox WHERE id = ?", id).toArray());
    for (const row of rows) this.sql.exec("UPDATE outbox SET next_at = ? WHERE id = ?", now + LEASE_MS, row.id);
    const results = await Promise.allSettled(
      rows.map((row) => this.sendToAccount(row.account_id, JSON.parse(row.payload) as Delivery[])),
    );
    let delivered = 0;
    results.forEach((r, i) => {
      const row = rows[i];
      if (r.status === "fulfilled") {
        this.sql.exec("DELETE FROM outbox WHERE id = ?", row.id);
        delivered++;
        return;
      }
      const attempts = row.attempts + 1;
      if (now - row.created_at >= GIVE_UP_MS) {
        console.error(`outbox ${row.id} for account ${row.account_id} dropped after ${attempts} attempts: ${r.reason}`);
        this.sql.exec("DELETE FROM outbox WHERE id = ?", row.id);
        return;
      }
      const backoff = Math.min(RETRY_FIRST_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
      this.sql.exec("UPDATE outbox SET attempts = ?, next_at = ? WHERE id = ?", attempts, now + backoff, row.id);
    });
    return { delivered, queued: ids.length - delivered };
  }

  // Separate so tests can make an account fail.
  protected async sendToAccount(account: number, items: Delivery[]): Promise<void> {
    const stub = this.env.ACCOUNT.get(this.env.ACCOUNT.idFromName(`acct:${account}`));
    await stub.deliver(items);
  }

  // The single alarm covers outbox retries, the end of a throttle,
  // subscriptions' expiry and verification, and pruning `deliveries`.
  private scheduleAlarm(): void {
    const times = [
      this.sql.exec<{ t: number | null }>("SELECT MIN(next_at) AS t FROM outbox").one().t,
      this.sql.exec<{ t: number | null }>("SELECT MIN(MIN(expires_at, COALESCE(verified_until, expires_at))) AS t FROM subscriptions").one().t,
      this.throttledUntil(),
      Number(this.getMeta("prune_at") ?? 0) || null,
    ].filter((t): t is number => t !== null);
    if (times.length) void this.ctx.storage.setAlarm(Math.min(...times));
    else void this.ctx.storage.deleteAlarm();
  }

  // While a repo-wide subscription filters on base or author, open PRs
  // are kept for it.
  private forgetPrIfUnwatched(pr: number): void {
    const keepOpen = this.tracksAllPrs() ? " AND state IS NOT 'open'" : "";
    this.sql.exec(`DELETE FROM prs WHERE number = ?${keepOpen} AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE pr = ?)`, pr, pr);
  }

  // Whether a repo-wide subscription filters on base or author, kept in
  // `meta` so ingest needn't scan the subscriptions. Recomputed when a
  // repo-wide subscription goes; once none is left, only watched PRs are
  // kept.
  private refreshTracking(): void {
    const tracking = this.sql
      .exec(
        "SELECT 1 FROM subscriptions WHERE pr IS NULL AND (json_extract(spec, '$.base') IS NOT NULL OR json_extract(spec, '$.author') IS NOT NULL) LIMIT 1",
      )
      .toArray().length > 0;
    if (tracking) {
      this.setMeta("tracks_all_prs", "1");
      return;
    }
    this.deleteMeta("tracks_all_prs");
    this.sql.exec("DELETE FROM prs WHERE number NOT IN (SELECT pr FROM subscriptions WHERE pr IS NOT NULL)");
  }

  private tracksAllPrs(): boolean {
    return this.getMeta("tracks_all_prs") === "1";
  }

  // Makes room for `n` more rows under the limit by forgetting the PRs
  // least recently written that no PR subscription watches. Returns how
  // many rows there's room for.
  private roomForPrs(n: number): number {
    const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM prs").one().n;
    const over = count + n - REPO_LIMITS.trackedPrs;
    if (over > 0) {
      this.sql.exec(
        `DELETE FROM prs WHERE number IN (
           SELECT number FROM prs WHERE number NOT IN (SELECT pr FROM subscriptions WHERE pr IS NOT NULL)
           ORDER BY COALESCE(seen_at, 0), number LIMIT ?)`,
        over,
      );
    }
    return REPO_LIMITS.trackedPrs - this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM prs").one().n;
  }

  // A row for an open PR, if there isn't one.
  private trackPr(pr: number, now: number): void {
    if (this.sql.exec("SELECT 1 FROM prs WHERE number = ?", pr).toArray().length) return;
    if (this.roomForPrs(1) < 1) return;
    this.sql.exec("INSERT INTO prs (number, state, seen_at) VALUES (?, 'open', ?)", pr, now);
  }

  // RPC: the repo's open PRs, listed by the Worker after `subscribe`
  // answered `needs_open_prs`, so PRs opened before the filter can match.
  // One statement; rows already right aren't rewritten.
  rememberOpenPrs(open: OpenPr[]): void {
    if (!this.tracksAllPrs()) return;
    const prs = open.filter((p) => Number.isSafeInteger(p.number) && p.number > 0).slice(0, 100);
    const known = new Set(this.sql
      .exec<{ number: number }>("SELECT number FROM prs WHERE number IN (SELECT value FROM json_each(?))", JSON.stringify(prs.map((p) => p.number)))
      .toArray()
      .map((r) => r.number));
    const fresh = prs.filter((p) => !known.has(p.number));
    const room = fresh.length ? this.roomForPrs(fresh.length) : 0;
    const rows = [...prs.filter((p) => known.has(p.number)), ...fresh.slice(0, Math.max(room, 0))].map((p) => ({
      number: p.number, draft: p.draft ? 1 : 0, head_sha: p.head_sha, base_ref: p.base_ref, author: p.author,
    }));
    if (!rows.length) return;
    this.sql.exec(
      `INSERT INTO prs (number, state, draft, head_sha, base_ref, author, seen_at)
       SELECT json_extract(value, '$.number'), 'open', json_extract(value, '$.draft'), json_extract(value, '$.head_sha'),
         json_extract(value, '$.base_ref'), json_extract(value, '$.author'), ?
       FROM json_each(?) WHERE true
       ON CONFLICT (number) DO UPDATE SET state = 'open', draft = excluded.draft, head_sha = excluded.head_sha,
         base_ref = excluded.base_ref, author = excluded.author, seen_at = excluded.seen_at
       WHERE prs.state IS NOT 'open' OR prs.draft IS NOT excluded.draft OR prs.head_sha IS NOT excluded.head_sha
         OR prs.base_ref IS NOT excluded.base_ref OR prs.author IS NOT excluded.author`,
      this.now(), JSON.stringify(rows),
    );
  }

  private getMeta(k: string): string | null {
    return this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v ?? null;
  }

  private setMeta(k: string, v: string): void {
    this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", k, v);
  }

  private deleteMeta(k: string): void {
    this.sql.exec("DELETE FROM meta WHERE k = ?", k);
  }
}

function toSubscription(row: SubRow): Subscription {
  const spec = JSON.parse(row.spec) as { kinds: string[]; ignore: Ignore; base?: string; author?: string };
  return {
    id: row.id,
    account: row.account_id,
    inbox: row.inbox,
    pr: row.pr,
    kinds: spec.kinds,
    ...(spec.base === undefined ? {} : { base: spec.base }),
    ...(spec.author === undefined ? {} : { author: spec.author }),
    ignore: spec.ignore,
    created_at: row.created_at,
    expires_at: row.expires_at,
    verified_until: row.verified_until ?? null,
  };
}

// A repo-wide subscription's `base` and `author`: the event must be about
// a PR known to target that branch, or to be by that login.
function filterMatches(sub: Subscription, pr: PrRow | undefined): boolean {
  if (sub.base === undefined && sub.author === undefined) return true;
  if (!pr) return false;
  return (sub.base === undefined || pr.base_ref === sub.base) && (sub.author === undefined || pr.author?.toLowerCase() === sub.author);
}

function ignored(sub: Subscription, e: UnsequencedEvent): boolean {
  if (!e.actor) return false;
  return (
    (sub.ignore.self && e.actor.id === sub.account) ||
    (sub.ignore.bots && e.actor.bot) ||
    sub.ignore.actors.includes(e.actor.login)
  );
}

function push(out: Map<number, Delivery[]>, account: number, item: Delivery): void {
  const list = out.get(account);
  if (list) list.push(item);
  else out.set(account, [item]);
}

function countItems(out: Map<number, Delivery[]>): number {
  let n = 0;
  for (const items of out.values()) n += items.length;
  return n;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(now: number): string {
  let time = "";
  for (let i = 0, t = now; i < 10; i++, t = Math.floor(t / 32)) time = CROCKFORD[t % 32] + time;
  let rand = "";
  for (const b of crypto.getRandomValues(new Uint8Array(16))) rand += CROCKFORD[b % 32];
  return time + rand;
}
