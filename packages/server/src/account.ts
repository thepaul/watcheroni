import { DurableObject } from "cloudflare:workers";
import type { AccountKind } from "./kinds";
import type { ActivityItem } from "./repo-hub";
import {
  ACCOUNT_MAX_INBOXES,
  ACCOUNT_MAX_KEYS,
  ACCOUNT_MAX_LONG_POLLS,
  ACCOUNT_MAX_SOCKETS,
  ACCOUNT_MAX_SUBSCRIPTIONS,
  ACCOUNT_REQUESTS_PER_MINUTE,
  INBOX_IDLE_DAYS,
  INBOX_MAX_AGE_DAYS,
  INBOX_MAX_EVENTS,
  MAX_LIMIT,
  problem,
  withRetryAfter,
  type KeyInfo,
  type ClientMessage,
  type EventsPage,
  type InboxInfo,
  type ServerMessage,
  type SubscriptionInfo,
  type UnsequencedEvent,
  type WatchEvent,
} from "./protocol";

// What each WebSocket remembers across hibernation. `pos` is the last seq
// sent down this socket; null means a client socket that hasn't sent
// `hello` yet, so nothing is pushed to it.
interface Attachment {
  inbox: string;
  mode: "client" | "bridge";
  keyId: string | null;
  pos: number | null;
  connectedAt: number;
}

// A type alias, not an interface, so it satisfies SqlStorage's row constraint.
type InboxRow = {
  name: string;
  created_at: number;
  last_read_at: number | null;
  head: number;
  acked: number;
};

type SubscriptionRow = {
  id: string;
  inbox: string;
  repo_id: number;
  repo_name: string;
  private: number;
  pr: number | null;
  spec: string;
  created_at: number;
  expires_at: number;
  verified_until: number | null;
};

// An account cap that refused a request, as the problem the Worker answers with.
export type Refusal = { ok: false; status: number; code: string; detail: string };
// `checked_at` goes back to saveSubscription, which refuses if the inbox
// was deleted, or a delete began on it, since.
export type SubscriptionCheck = { ok: true; checked_at: number } | Refusal;
export type SubscriptionSave = { ok: true } | Refusal;
// Which delete, of which inbox: the deleting mark's time, and the inbox's
// `created_at`, which tells one life of a name from the next.
export interface DeleteTicket {
  mark: number;
  life: number;
}
// The first step of DELETE /v1/inboxes/{name}: the subscriptions to take
// back from their RepoHubs, and the ticket the Worker hands back to
// deleteInbox, or to cancelDeleteInbox if it can't finish.
export type DeleteBegun = { ok: true; ticket: DeleteTicket; subscriptions: SubscriptionInfo[] } | Refusal;

type KeyRow = {
  id: string;
  label: string | null;
  created_at: number;
  last_used_at: number | null;
};

// The account's request budget, for the RateLimit-* headers.
export interface RateState {
  limit: number;
  remaining: number;
  reset: number; // seconds until the bucket is full again
}

export type AuthResult =
  | { ok: true; keyId: string; rate: RateState }
  | { ok: false; reason: "unauthorized" }
  | { ok: false; reason: "rate_limited"; retryAfter: number; rate: RateState };

export interface Delivery {
  inbox: string;
  event: UnsequencedEvent;
}

export interface AccountStats {
  instance: string;
  startedAt: string;
  // Each instance of this object that did any work: the first, and one
  // each time it woke from hibernation or eviction. A new entry while
  // sockets stayed open is the evidence that it hibernated.
  wakes: { instance: string; at: string }[];
  sockets: { inbox: string; mode: string; pos: number | null; connectedAt: string }[];
  inboxes: InboxRow[];
}

const WAKES_KEPT = 200;
// last_used_at is only a hint for `GET /v1/keys`; writing it on every
// request would be a write per request.
const LAST_USED_GRANULARITY_MS = 60 * 60 * 1000;
const SUBPROTOCOL = "watcheroni.v1";
// How long a client refused for too many long polls should wait. Most end
// well within this, when an event comes or their wait runs out.
const LONG_POLL_RETRY_SECONDS = 30;
const INBOX_MAX_AGE_MS = INBOX_MAX_AGE_DAYS * 24 * 3600 * 1000;
// The alarm that deletes events past INBOX_MAX_AGE_MS runs at most this
// often. Reads leave them out meanwhile, so this only bounds how long they
// take up storage.
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
// How long a deleting mark (beginDeleteInbox) holds. A mark outlives its
// delete only if the Worker running it dies between beginDeleteInbox and
// deleteInbox or cancelDeleteInbox; after this it's taken for abandoned,
// so subscribing works again and another delete can take over. What runs
// between those calls is one request's RepoHub.unsubscribe calls, run at
// once (Promise.allSettled), each a few SQL statements in one RepoHub, so
// a live delete gets through them in well under a second. 60 seconds is
// far beyond that, while short enough that an inbox left marked isn't
// refused subscriptions for long.
//
// The runtime sets the Worker no fixed wall-clock limit, so a slow delete
// can still outlive its mark. What holds then: whatever finds the mark
// lapsed (deletingMark) takes it over, and deleteInbox and
// cancelDeleteInbox act on a mark only while it is the one their ticket
// names, still live, so the late delete can't finish or lift a newer
// mark. Its RepoHub.unsubscribe calls may still land late, but each
// carries the mark's time, and RepoHub keeps any subscription made or
// renewed by a request checked (checkSubscription) at or after it. So a
// subscription a client was told about after the mark lapsed is never
// ended by the late delete; the delete answers 503 instead.
const DELETE_MARK_MS = 60 * 1000;

export class Account extends DurableObject<Env> {
  private readonly instance = crypto.randomUUID();
  private readonly startedAt = Date.now();
  private readonly sql: SqlStorage;
  // The last tick() handed out; read from `meta` on first use.
  private lastTick: number | null = null;
  // Whether this account's tables exist. The Worker turns away keys
  // without a valid tag, but checking the key's hash is this object's job;
  // as a second line of defence, it writes nothing until login makes the
  // account (createKey) or a key is accepted, so a request that gets this
  // far with a bad key leaves no storage behind.
  private created: boolean;
  private opened = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.created = this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'keys'").toArray().length > 0;
    if (this.created) this.migrate();
    // Keepalives are answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // Before this instance's first write, once the caller is known to be
  // genuine: the tables, for a new account, and a row in `wakes`.
  private open(): void {
    if (this.opened) return;
    if (!this.created) this.migrate();
    this.created = true;
    this.opened = true;
    this.sql.exec("INSERT INTO wakes (instance, at) VALUES (?, ?)", this.instance, this.startedAt);
    this.sql.exec(
      "DELETE FROM wakes WHERE rowid NOT IN (SELECT rowid FROM wakes ORDER BY at DESC LIMIT ?)",
      WAKES_KEPT,
    );
  }

  // Account's clock for the times compared to tell what happened first:
  // inboxes' `created_at`, deleting marks, and checkSubscription's
  // `checked_at` (which RepoHub keeps, for unsubscribe). Milliseconds, as
  // Date.now(), but strictly increasing, kept in `meta` across restarts,
  // so no two share a value and their order is the order they were taken.
  private tick(): number {
    this.lastTick ??= Number(this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'tick'").toArray()[0]?.v ?? 0);
    const t = Math.max(Date.now(), this.lastTick + 1);
    this.lastTick = t;
    this.sql.exec("INSERT INTO meta (k, v) VALUES ('tick', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", String(t));
    return t;
  }

  private migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS inboxes (
        name TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        last_read_at INTEGER,
        head INTEGER NOT NULL DEFAULT 0,
        acked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS events (
        inbox TEXT NOT NULL,
        seq INTEGER NOT NULL,
        id TEXT NOT NULL,
        body TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (inbox, seq)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS events_dedupe ON events (inbox, id);
      CREATE TABLE IF NOT EXISTS wakes (instance TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS keys (
        id TEXT PRIMARY KEY,
        hash BLOB NOT NULL,
        label TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS keys_hash ON keys (hash);
      CREATE TABLE IF NOT EXISTS ticket_nonces (nonce TEXT PRIMARY KEY, exp INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS buckets (name TEXT PRIMARY KEY, tokens REAL NOT NULL, updated_at INTEGER NOT NULL);
      -- The account's index of its subscriptions; RepoHub holds the copy
      -- that routes events.
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        inbox TEXT NOT NULL,
        repo_id INTEGER NOT NULL,
        repo_name TEXT NOT NULL,
        private INTEGER NOT NULL,
        pr INTEGER,
        spec TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        verified_until INTEGER
      );
      CREATE INDEX IF NOT EXISTS subscriptions_inbox ON subscriptions (inbox);
      -- Where each deleted inbox that had had events had got to, so one
      -- made again under its name carries on from there.
      CREATE TABLE IF NOT EXISTS deleted_inboxes (name TEXT PRIMARY KEY, head INTEGER NOT NULL, acked INTEGER NOT NULL);
      -- When a subscription to each inbox was last asked for, so it isn't
      -- taken for idle while the Worker makes one (checkSubscription).
      CREATE TABLE IF NOT EXISTS subscribing (inbox TEXT PRIMARY KEY, at INTEGER NOT NULL);
      -- When a DELETE last began on each inbox, and whether it's still
      -- under way (active); the inbox takes no new subscriptions
      -- meanwhile (beginDeleteInbox). Kept once it ends, so a
      -- subscription checked before it began isn't saved after.
      CREATE TABLE IF NOT EXISTS deleting (inbox TEXT PRIMARY KEY, at INTEGER NOT NULL, active INTEGER NOT NULL);
    `);
  }

  // RPC, at login: store a new key's hash. The Worker has already checked
  // the user's GitHub token and made the key; the key itself never gets here.
  createKey(id: string, hash: ArrayBuffer, label: string | null, login: string): { ok: true; key: KeyInfo } | Refusal {
    this.open();
    const live = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM keys WHERE revoked_at IS NULL").one().n;
    if (live >= ACCOUNT_MAX_KEYS) {
      return { ok: false, status: 422, code: "quota_exceeded", detail: `Too many API keys on this account (at most ${ACCOUNT_MAX_KEYS})` };
    }
    const now = Date.now();
    this.sql.exec("INSERT INTO meta (k, v) VALUES ('login', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", login);
    this.sql.exec("INSERT OR IGNORE INTO meta (k, v) VALUES ('created_at', ?)", String(now));
    this.sql.exec("INSERT INTO keys (id, hash, label, created_at) VALUES (?, ?, ?, ?)", id, hash, label, now);
    return { ok: true, key: keyInfo({ id, label, created_at: now, last_used_at: null }) };
  }

  // RPC, on every API request: is this a live key, and is there budget
  // left? The hash is of 32 random bytes, so looking it up with `=` leaks
  // nothing useful through timing. Nothing is written for a key that
  // doesn't match, not even the rate limit's bucket.
  authenticate(hash: ArrayBuffer): AuthResult {
    if (!this.created) return { ok: false, reason: "unauthorized" };
    const key = this.sql
      .exec<{ id: string; last_used_at: number | null }>(
        "SELECT id, last_used_at FROM keys WHERE hash = ? AND revoked_at IS NULL",
        hash,
      )
      .toArray()[0];
    if (!key) return { ok: false, reason: "unauthorized" };
    this.open();
    const now = Date.now();
    if (key.last_used_at === null || now - key.last_used_at >= LAST_USED_GRANULARITY_MS) {
      this.sql.exec("UPDATE keys SET last_used_at = ? WHERE id = ?", now, key.id);
    }
    const rate = this.take("requests", ACCOUNT_REQUESTS_PER_MINUTE, 60_000, now);
    if (rate.retryAfter) return { ok: false, reason: "rate_limited", retryAfter: rate.retryAfter, rate: rate.state };
    return { ok: true, keyId: key.id, rate: rate.state };
  }

  // RPC: live keys, oldest first. Also reached for any GitHub user who
  // revokes the App (revokeAllKeys), who may never have signed in.
  listKeys(): KeyInfo[] {
    if (!this.created) return [];
    return this.sql
      .exec<KeyRow>("SELECT id, label, created_at, last_used_at FROM keys WHERE revoked_at IS NULL ORDER BY id")
      .toArray()
      .map(keyInfo);
  }

  // RPC: revoke a key and hang up its WebSockets. False if there was no
  // such live key.
  revokeKey(id: string): boolean {
    const { rowsWritten } = this.sql.exec("UPDATE keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", Date.now(), id);
    for (const ws of this.ctx.getWebSockets(`key:${id}`)) ws.close(4001, "key revoked");
    return rowsWritten > 0;
  }

  // RPC: revoke every key, for when the user revokes the App's
  // authorization on GitHub (the github_app_authorization webhook).
  revokeAllKeys(): number {
    let n = 0;
    for (const { id } of this.listKeys()) if (this.revokeKey(id)) n++;
    return n;
  }

  private keyActive(id: string): boolean {
    return this.created && this.sql.exec("SELECT 1 FROM keys WHERE id = ? AND revoked_at IS NULL", id).toArray().length > 0;
  }

  // Remembers a ticket's nonce until the ticket expires. False if it was
  // already used.
  private useNonce(nonce: string, exp: number): boolean {
    const now = Math.floor(Date.now() / 1000);
    this.sql.exec("DELETE FROM ticket_nonces WHERE exp <= ?", now);
    const { rowsWritten } = this.sql.exec("INSERT OR IGNORE INTO ticket_nonces (nonce, exp) VALUES (?, ?)", nonce, exp);
    return rowsWritten > 0;
  }

  // A token bucket holding `capacity` tokens, refilled at `capacity` per
  // `periodMs` (DESIGN.md, "Limits"). Takes one token if there is one.
  private take(name: string, capacity: number, periodMs: number, now: number): { state: RateState; retryAfter: number } {
    const row = this.sql
      .exec<{ tokens: number; updated_at: number }>("SELECT tokens, updated_at FROM buckets WHERE name = ?", name)
      .toArray()[0];
    const perMs = capacity / periodMs;
    let tokens = row ? Math.min(capacity, row.tokens + (now - row.updated_at) * perMs) : capacity;
    let retryAfter = 0;
    if (tokens >= 1) tokens -= 1;
    else retryAfter = Math.ceil((1 - tokens) / perMs / 1000);
    this.sql.exec(
      "INSERT INTO buckets (name, tokens, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at",
      name, tokens, now,
    );
    const state = { limit: capacity, remaining: Math.floor(tokens), reset: Math.ceil((capacity - tokens) / perMs / 1000) };
    return { state, retryAfter };
  }

  // RPC: create the inbox if needed and there's room for it.
  openInbox(name: string): { ok: true; inbox: InboxInfo } | Refusal {
    this.open();
    const room = this.roomForInbox(name);
    return room.ok ? { ok: true, inbox: this.inboxInfoOf(this.ensureInbox(name)) } : room;
  }

  // RPC: every inbox, by name.
  listInboxes(): InboxInfo[] {
    if (!this.created) return [];
    return this.sql.exec<InboxRow>("SELECT * FROM inboxes ORDER BY name").toArray().map((row) => this.inboxInfoOf(row));
  }

  // RPC: one inbox, or null if there's no such inbox. Not a read: it
  // leaves `last_read_at` alone.
  inboxInfo(name: string): InboxInfo | null {
    const row = this.inbox(name);
    return row ? this.inboxInfoOf(row) : null;
  }

  // RPC, the first step of DELETE /v1/inboxes/{name}: answers the inbox's
  // subscriptions, for the Worker to take back from their RepoHubs, and
  // marks the inbox as being deleted, so that it takes no new ones
  // meanwhile (checkSubscription and saveSubscription refuse them) that
  // the delete would then drop. With `since`, refuses instead if the inbox
  // has been used since then (usedSince); this runs without an await, so
  // nothing can use it between the check and the mark. Refuses too while
  // another delete holds a live mark. The Worker ends with deleteInbox,
  // or cancelDeleteInbox if it can't.
  beginDeleteInbox(name: string, since: number | null): DeleteBegun {
    const inbox = this.inbox(name);
    if (!inbox) return { ok: false, status: 404, code: "not_found", detail: "No such inbox" };
    this.open();
    const now = this.tick();
    if (this.deletingMark(name, now)?.active) return beingDeletedRefusal();
    if (since !== null) {
      const used = this.usedSince(inbox, since);
      if (used.length) {
        return {
          ok: false,
          status: 409,
          code: "inbox_in_use",
          detail: `Inbox has been used since ${new Date(since).toISOString()}: ${used.join("; ")}`,
        };
      }
    }
    this.sql.exec(
      "INSERT INTO deleting (inbox, at, active) VALUES (?, ?, 1) ON CONFLICT (inbox) DO UPDATE SET at = excluded.at, active = 1",
      name, now,
    );
    return { ok: true, ticket: { mark: now, life: inbox.created_at }, subscriptions: this.listSubscriptions(name)! };
  }

  // RPC, when the Worker couldn't finish a delete: forgets the
  // subscriptions that did end (`ended`), so the index says what RepoHub
  // has, and lifts the mark, so the inbox can be subscribed to again. The
  // index is touched only if the inbox is the one the delete began on, not
  // one made again under its name since, and the mark only if it is still
  // this delete's.
  cancelDeleteInbox(name: string, ticket: DeleteTicket, ended: string[]): void {
    if (this.inbox(name)?.created_at === ticket.life) {
      for (const id of ended) this.sql.exec("DELETE FROM subscriptions WHERE inbox = ? AND id = ?", name, id);
    }
    if (this.created) this.sql.exec("UPDATE deleting SET active = 0 WHERE inbox = ? AND at = ? AND active = 1", name, ticket.mark);
  }

  // RPC, the last step of DELETE /v1/inboxes/{name}, once the RepoHubs
  // have given up all of `listed`: deletes the inbox with its events and
  // subscriptions, and hangs up its sockets. Only if the delete's mark is
  // still there and live, which means for certain that since
  // beginDeleteInbox no subscription was saved (saveSubscription refuses
  // while it's live, and takes it over, ending it, once it lapses) and the
  // inbox wasn't dropped or made again (dropInbox removes the mark).
  // Otherwise returns false, having forgotten `listed` as
  // cancelDeleteInbox does, since RepoHub has ended them; the Worker asks
  // the client to try again.
  deleteInbox(name: string, ticket: DeleteTicket, listed: string[]): boolean {
    const inbox = this.inbox(name);
    const mark = this.created
      ? this.sql.exec<{ at: number; active: number }>("SELECT at, active FROM deleting WHERE inbox = ?", name).toArray()[0]
      : undefined;
    if (!inbox || inbox.created_at !== ticket.life || !mark || mark.at !== ticket.mark || !mark.active) {
      this.cancelDeleteInbox(name, ticket, listed);
      return false;
    }
    this.open();
    const known = new Set(listed);
    const unlisted = (this.listSubscriptions(name) ?? []).filter((s) => !known.has(s.id));
    if (unlisted.length) {
      // Unreachable, by the mark: there's no way to save one without it.
      // Should it happen, the delete gives up rather than drop them.
      console.error(`deleting inbox ${name}: subscriptions saved during the delete: ${unlisted.map((s) => s.id).join(", ")}`);
      this.cancelDeleteInbox(name, ticket, listed);
      return false;
    }
    this.dropInbox(name);
    for (const ws of this.ctx.getWebSockets(`inbox:${name}`)) ws.close(4004, "inbox deleted");
    return true;
  }

  // Has the inbox been used at `since` or later? Each way it has, said for
  // the 409 inbox_in_use; none if it hasn't. Every one is a definite fact
  // this object keeps: made, read (an HTTP read, or a WebSocket's
  // `hello`), asked to be subscribed to (checkSubscription notes every
  // attempt, renewals too), subscribed to, or connected to right now (a
  // WebSocket, or a long poll's bridge), which covers a client that has
  // streamed over one socket since its `hello`, long before `since`.
  private usedSince(inbox: InboxRow, since: number): string[] {
    const at = (ms: number) => new Date(ms).toISOString();
    const used: string[] = [];
    if (inbox.created_at >= since) used.push(`created at ${at(inbox.created_at)}`);
    if (inbox.last_read_at !== null && inbox.last_read_at >= since) used.push(`read at ${at(inbox.last_read_at)}`);
    const asked = this.sql
      .exec<{ at: number }>("SELECT at FROM subscribing WHERE inbox = ? AND at >= ?", inbox.name, since)
      .toArray()[0];
    if (asked) used.push(`a subscription asked for at ${at(asked.at)}`);
    const made = this.sql
      .exec<{ at: number | null }>("SELECT MAX(created_at) AS at FROM subscriptions WHERE inbox = ? AND created_at >= ?", inbox.name, since)
      .one().at;
    if (made !== null) used.push(`a subscription made at ${at(made)}`);
    const sockets = this.ctx.getWebSockets(`inbox:${inbox.name}`).length;
    if (sockets) used.push(`${sockets} ${sockets === 1 ? "connection" : "connections"} open`);
    return used;
  }

  // The inbox's deleting mark (beginDeleteInbox): when a delete last
  // began on it, and whether it's under way. A live mark that has lapsed
  // (DELETE_MARK_MS) is taken over first, made not live, so the delete
  // that wrote it can't finish (deleteInbox) after whatever comes next.
  private deletingMark(name: string, now = Date.now()): { at: number; active: boolean } | null {
    if (!this.created) return null;
    const row = this.sql.exec<{ at: number; active: number }>("SELECT at, active FROM deleting WHERE inbox = ?", name).toArray()[0];
    if (!row) return null;
    // A mark is tick() time, which never goes back; should the wall clock
    // go back, the mark lapses that much later. That's the safe way: an
    // inbox held longer, never a delete's hold cut short.
    if (row.active && row.at <= now - DELETE_MARK_MS) {
      this.sql.exec("UPDATE deleting SET active = 0 WHERE inbox = ?", name);
      return { at: row.at, active: false };
    }
    return { at: row.at, active: !!row.active };
  }

  // The inbox as the API shows it. `oldest` leaves out events past
  // INBOX_MAX_AGE_MS that the alarm hasn't deleted yet, as reads do.
  private inboxInfoOf(row: InboxRow): InboxInfo {
    const oldest = this.sql
      .exec<{ seq: number | null }>("SELECT MIN(seq) AS seq FROM events WHERE inbox = ? AND at >= ?", row.name, Date.now() - INBOX_MAX_AGE_MS)
      .one().seq;
    const subscriptions = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM subscriptions WHERE inbox = ?", row.name).one().n;
    return {
      name: row.name,
      created_at: new Date(row.created_at).toISOString(),
      head: row.head,
      acked: row.acked,
      oldest: oldest ?? row.head + 1,
      subscriptions,
      last_read_at: row.last_read_at === null ? null : new Date(row.last_read_at).toISOString(),
    };
  }

  // Deletes an inbox and everything kept for it, remembering its `head`
  // and `acked` so the name never reuses a seq (see ensureInbox).
  private dropInbox(name: string): void {
    this.sql.exec("DELETE FROM events WHERE inbox = ?", name);
    this.sql.exec("DELETE FROM subscriptions WHERE inbox = ?", name);
    // One that never had an event would start again just the same without
    // a row, so it leaves none: making and deleting empty inboxes costs no
    // storage.
    this.sql.exec("INSERT OR REPLACE INTO deleted_inboxes (name, head, acked) SELECT name, head, acked FROM inboxes WHERE name = ? AND head > 0", name);
    this.sql.exec("DELETE FROM inboxes WHERE name = ?", name);
    this.sql.exec("DELETE FROM subscribing WHERE inbox = ?", name);
    this.sql.exec("DELETE FROM deleting WHERE inbox = ?", name);
  }

  // Creates the inbox if needed, whatever the cap. Only API calls and
  // client sockets are held to it; /debug deliveries go to inboxes they
  // made. RepoHub's deliveries and long-poll bridges never make one.
  // An inbox made again after roomForInbox deleted it takes up its old
  // `head` and `acked`, as if its events had all expired: seqs are never
  // reused, so a reader still holding a position from before is behind
  // (and gets `inbox.gap`), never silently ahead. PROTOCOL.md promises
  // that, so every way of deleting an inbox goes through dropInbox, which
  // writes deleted_inboxes.
  private ensureInbox(name: string): InboxRow {
    this.open();
    const existing = this.inbox(name);
    if (existing) return existing;
    const old = this.sql
      .exec<{ head: number; acked: number }>("SELECT head, acked FROM deleted_inboxes WHERE name = ?", name)
      .toArray()[0];
    this.sql.exec(
      "INSERT INTO inboxes (name, created_at, head, acked) VALUES (?, ?, ?, ?)",
      name, this.tick(), old?.head ?? 0, old?.acked ?? 0,
    );
    if (old) this.sql.exec("DELETE FROM deleted_inboxes WHERE name = ?", name);
    return this.inbox(name)!;
  }

  // Is there room for the inbox, if it's new? At the cap, deletes the
  // inboxes nobody has read (or asked to subscribe to) for
  // INBOX_IDLE_DAYS, if nothing is subscribed or connected to them, to
  // make some.
  private roomForInbox(name: string): { ok: true } | Refusal {
    if (this.inbox(name)) return { ok: true };
    const count = () => this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM inboxes").one().n;
    if (count() < ACCOUNT_MAX_INBOXES) return { ok: true };
    const idle = this.sql
      .exec<{ name: string }>(
        `SELECT name FROM inboxes WHERE MAX(created_at, COALESCE(last_read_at, 0)) < ?1
         AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE subscriptions.inbox = inboxes.name)
         AND NOT EXISTS (SELECT 1 FROM subscribing WHERE subscribing.inbox = inboxes.name AND subscribing.at >= ?1)`,
        Date.now() - INBOX_IDLE_DAYS * 24 * 3600 * 1000,
      )
      .toArray();
    for (const { name: old } of idle) {
      if (this.ctx.getWebSockets(`inbox:${old}`).length) continue;
      this.dropInbox(old);
    }
    if (count() < ACCOUNT_MAX_INBOXES) return { ok: true };
    return { ok: false, status: 422, code: "quota_exceeded", detail: `Too many inboxes on this account (at most ${ACCOUNT_MAX_INBOXES})` };
  }

  // RPC: one page of events after `after` (or after `acked` when null).
  // Returns null if the inbox doesn't exist.
  readEvents(name: string, after: number | null, limit: number): EventsPage | null {
    const inbox = this.inbox(name);
    if (!inbox) return null;
    this.open();
    this.sql.exec("UPDATE inboxes SET last_read_at = ? WHERE name = ?", Date.now(), name);
    const from = after ?? inbox.acked;
    const events = this.eventsAfter(name, from, limit, inbox.head);
    return {
      events,
      next: events.length ? events[events.length - 1].seq : from,
      head: inbox.head,
      acked: inbox.acked,
    };
  }

  // RPC: move the acknowledged position forward, never back. An ack past
  // head is ignored, not taken as head: it's from a position this inbox
  // never gave out (its numbering went back), and taking it as head would
  // acknowledge events of the inbox's new life the client hasn't read.
  ack(name: string, seq: number): InboxRow | null {
    if (!this.inbox(name)) return null;
    this.open();
    this.sql.exec("UPDATE inboxes SET acked = MAX(acked, ?) WHERE name = ? AND ? <= head", seq, name, seq);
    return this.inbox(name);
  }

  // RPC, before subscribing: does the inbox exist, and is there room for
  // another subscription? The Worker calls RepoHub before saveSubscription,
  // and other requests run here meanwhile, so this notes the inbox in
  // `subscribing`: roomForInbox, making room for another inbox, then won't
  // take it for idle for INBOX_IDLE_DAYS. (Not by setting `last_read_at`,
  // which would also keep the inbox's subscriptions from expiring.) The
  // note also counts as use for a conditional delete (usedSince). An inbox
  // being deleted takes no new subscription.
  checkSubscription(inbox: string): SubscriptionCheck {
    if (!this.inbox(inbox)) return { ok: false, status: 404, code: "not_found", detail: "No such inbox" };
    this.open();
    if (this.deletingMark(inbox)?.active) return beingDeletedRefusal();
    const n = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM subscriptions").one().n;
    if (n >= ACCOUNT_MAX_SUBSCRIPTIONS) {
      return { ok: false, status: 422, code: "quota_exceeded", detail: `Too many subscriptions on this account (at most ${ACCOUNT_MAX_SUBSCRIPTIONS})` };
    }
    const now = this.tick();
    this.sql.exec(
      "INSERT INTO subscribing (inbox, at) VALUES (?, ?) ON CONFLICT (inbox) DO UPDATE SET at = excluded.at",
      inbox, now,
    );
    return { ok: true, checked_at: now };
  }

  // RPC, once RepoHub has the subscription; `checkedAt` is what
  // checkSubscription answered. Refuses if the inbox is gone after all
  // (deleted, or deleted to make room), so no subscription is ever kept
  // for a missing inbox. Refuses too if a delete began on it since the
  // check, even one that has ended (a 503 that put the inbox back): that
  // delete may have ended this very subscription in RepoHub, as for a
  // renewal checked before it began, and saving it would answer 201 for a
  // dead one. Likewise if the inbox was deleted and made again since. The
  // Worker then takes back what RepoHub made. This runs without an await,
  // so nothing can delete the inbox between the checks and the insert.
  saveSubscription(sub: SubscriptionInfo, checkedAt: number): SubscriptionSave {
    const { baseline: _, ...rest } = sub;
    const inbox = this.inbox(rest.inbox);
    if (!inbox) return { ok: false, status: 404, code: "not_found", detail: "No such inbox" };
    if (inbox.created_at >= checkedAt) {
      return { ok: false, status: 409, code: "inbox_deleting", detail: "Inbox was deleted and made again while subscribing; try again" };
    }
    const mark = this.deletingMark(rest.inbox);
    if (mark?.active) return beingDeletedRefusal();
    if (mark && mark.at >= checkedAt) {
      return { ok: false, status: 409, code: "inbox_deleting", detail: "A delete of the inbox began while subscribing; try again" };
    }
    this.open();
    this.sql.exec(
      `INSERT INTO subscriptions (id, inbox, repo_id, repo_name, private, pr, spec, created_at, expires_at, verified_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET repo_name = excluded.repo_name, expires_at = excluded.expires_at, verified_until = excluded.verified_until`,
      rest.id, rest.inbox, rest.repo.id, rest.repo.full_name, rest.repo.private ? 1 : 0, rest.pr,
      JSON.stringify({ kinds: rest.kinds, ignore: rest.ignore, base: rest.base, author: rest.author }),
      Date.parse(rest.created_at), Date.parse(rest.expires_at),
      rest.verified_until === null ? null : Date.parse(rest.verified_until),
    );
    return { ok: true };
  }

  // RPC: an inbox's subscriptions, oldest first, or null if there's no
  // such inbox.
  listSubscriptions(inbox: string): SubscriptionInfo[] | null {
    if (!this.inbox(inbox)) return null;
    return this.sql
      .exec<SubscriptionRow>("SELECT * FROM subscriptions WHERE inbox = ? ORDER BY created_at, id", inbox)
      .toArray()
      .map(subscriptionInfo);
  }

  getSubscription(inbox: string, id: string): SubscriptionInfo | null {
    if (!this.created) return null;
    const row = this.sql.exec<SubscriptionRow>("SELECT * FROM subscriptions WHERE inbox = ? AND id = ?", inbox, id).toArray()[0];
    return row ? subscriptionInfo(row) : null;
  }

  // RPC, from RepoHub when subscriptions reach `expires_at`: when each
  // should now expire, counting from the last read of its inbox, or from
  // now if a client is connected to it. A time not in the future means
  // nobody has read the inbox for the whole TTL.
  subscriptionActivity(items: ActivityItem[]): Record<string, number> {
    this.open();
    const now = Date.now();
    const out: Record<string, number> = {};
    for (const item of items) {
      const inbox = this.inbox(item.inbox);
      const connected = this.ctx.getWebSockets(`inbox:${item.inbox}`).length > 0;
      const since = connected ? now : Math.max(inbox?.last_read_at ?? 0, item.created_at);
      out[item.id] = since + item.ttl_ms;
      this.sql.exec("UPDATE subscriptions SET expires_at = ? WHERE id = ?", out[item.id], item.id);
    }
    return out;
  }

  // RPC, after POST .../verify.
  setVerified(id: string, until: number): void {
    this.sql.exec("UPDATE subscriptions SET verified_until = ? WHERE id = ?", until, id);
  }

  // RPC: forgets a subscription, returning it so the Worker can tell its
  // RepoHub, or null if there was none.
  removeSubscription(inbox: string, id: string): SubscriptionInfo | null {
    const sub = this.getSubscription(inbox, id);
    if (sub) this.sql.exec("DELETE FROM subscriptions WHERE id = ?", id);
    return sub;
  }

  // RPC: append events to inboxes and push them to waiting sockets.
  // RepoHub passes `makeInboxes` false: its events are for inboxes that
  // had a subscription when it queued them, so one that's gone was deleted
  // (DELETE /v1/inboxes/{name}), and a late delivery mustn't make it
  // again. Those events are dropped. /debug makes inboxes as it goes.
  async deliver(items: Delivery[], makeInboxes = true): Promise<{ delivered: number; duplicates: number; dropped: number }> {
    let delivered = 0;
    let duplicates = 0;
    let dropped = 0;
    const touched = new Set<string>();
    for (const { inbox: name, event } of items) {
      if (!makeInboxes && !this.inbox(name)) {
        dropped++;
        continue;
      }
      const inbox = this.ensureInbox(name);
      const seen = this.sql.exec("SELECT 1 FROM events WHERE inbox = ? AND id = ?", name, event.id).toArray();
      if (seen.length) {
        duplicates++;
        continue;
      }
      const seq = inbox.head + 1;
      const body: WatchEvent = { ...event, seq };
      this.sql.exec(
        "INSERT INTO events (inbox, seq, id, body, at) VALUES (?, ?, ?, ?, ?)",
        name, seq, event.id, JSON.stringify(body), Date.now(),
      );
      this.sql.exec("UPDATE inboxes SET head = ? WHERE name = ?", seq, name);
      this.sql.exec("DELETE FROM events WHERE inbox = ? AND seq <= ?", name, seq - INBOX_MAX_EVENTS);
      touched.add(name);
      delivered++;
      // A `watch.*` event is the subscription's last.
      if (event.sub && event.kind.startsWith("watch.")) this.sql.exec("DELETE FROM subscriptions WHERE id = ?", event.sub);
    }
    // Whenever events are stored, an alarm is due to delete them once
    // they're too old; it sets the next one itself. It's due when the oldest
    // kept gets too old, which may be now for an account whose events
    // predate the alarm.
    if (delivered && (await this.ctx.storage.getAlarm()) === null) {
      const oldest = this.sql.exec<{ at: number }>("SELECT MIN(at) AS at FROM events").one().at;
      await this.ctx.storage.setAlarm(Math.max(oldest + INBOX_MAX_AGE_MS, Date.now()));
    }
    for (const name of touched) this.push(name);
    return { delivered, duplicates, dropped };
  }

  // Deletes every inbox's events older than INBOX_MAX_AGE_MS, then waits
  // for the next to get that old (but at least PRUNE_INTERVAL_MS, so a
  // steady stream of events doesn't wake it each time). Each inbox loses
  // everything up to its newest such event, so what's kept stays a run of
  // consecutive seqs, as eventsAfter expects.
  override async alarm(): Promise<void> {
    if (!this.created) return;
    this.open();
    const now = Date.now();
    const old = this.sql
      .exec<{ inbox: string; seq: number }>("SELECT inbox, MAX(seq) AS seq FROM events WHERE at < ? GROUP BY inbox", now - INBOX_MAX_AGE_MS)
      .toArray();
    for (const { inbox, seq } of old) this.sql.exec("DELETE FROM events WHERE inbox = ? AND seq <= ?", inbox, seq);
    const next = this.sql.exec<{ at: number | null }>("SELECT MIN(at) AS at FROM events").one().at;
    if (next !== null) await this.ctx.storage.setAlarm(Math.max(next + INBOX_MAX_AGE_MS, now + PRUNE_INTERVAL_MS));
  }

  // RPC: what the hibernation test looks at.
  stats(): AccountStats {
    if (!this.created) {
      return { instance: this.instance, startedAt: new Date(this.startedAt).toISOString(), wakes: [], sockets: [], inboxes: [] };
    }
    this.open();
    const wakes = this.sql
      .exec<{ instance: string; at: number }>("SELECT instance, at FROM wakes ORDER BY at DESC LIMIT 50")
      .toArray()
      .map((w) => ({ instance: w.instance, at: new Date(w.at).toISOString() }));
    const sockets = this.ctx.getWebSockets().map((ws) => {
      const a = ws.deserializeAttachment() as Attachment;
      return { inbox: a.inbox, mode: a.mode, pos: a.pos, connectedAt: new Date(a.connectedAt).toISOString() };
    });
    const inboxes = this.sql.exec<InboxRow>("SELECT * FROM inboxes ORDER BY name").toArray();
    return { instance: this.instance, startedAt: new Date(this.startedAt).toISOString(), wakes, sockets, inboxes };
  }

  // WebSocket upgrades only. The Worker has already checked the caller's
  // key or the ticket's signature and expiry, and the inbox name. A client
  // socket names its key, and a ticket's nonce and expiry; this checks the
  // key is still live and the ticket hasn't been used. Sockets are counted
  // by their tags, which outlast hibernation, and a socket drops out of
  // the count however it ends.
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const url = new URL(request.url);
    const name = url.searchParams.get("inbox") ?? "";
    const mode = url.searchParams.get("mode") === "bridge" ? "bridge" : "client";
    const keyId = url.searchParams.get("key");
    if (mode === "client") {
      const nonce = url.searchParams.get("nonce");
      if (!keyId || !this.keyActive(keyId)) return problem(401, "unauthorized", "Key revoked");
      if (nonce && !this.useNonce(nonce, Number(url.searchParams.get("exp")))) {
        return problem(401, "unauthorized", "Ticket already used");
      }
    }
    // A client that asks for a subprotocol fails the handshake unless the
    // server picks one.
    const offered = request.headers.get("Sec-WebSocket-Protocol")?.split(",").map((p) => p.trim()) ?? [];
    const responseHeaders: HeadersInit = offered.includes(SUBPROTOCOL) ? { "Sec-WebSocket-Protocol": SUBPROTOCOL } : {};
    if (mode === "client") {
      // Too many sockets is said with a close code, which clients see more
      // reliably than a refused handshake; the CLI long-polls instead.
      if (this.ctx.getWebSockets("mode:client").length >= ACCOUNT_MAX_SOCKETS) {
        return refuseSocket(4029, "too many connections", responseHeaders);
      }
      const room = this.roomForInbox(name);
      if (!room.ok) return problem(room.status, room.code, room.detail);
      this.ensureInbox(name);
    } else {
      // The inbox existed when the Worker read it, but may have been
      // deleted since; a bridge mustn't make it again.
      if (!this.inbox(name)) return problem(404, "not_found", "No such inbox");
      if (this.ctx.getWebSockets("mode:bridge").length >= ACCOUNT_MAX_LONG_POLLS) {
        const res = problem(429, "too_many_connections", `Too many long polls waiting on this account (at most ${ACCOUNT_MAX_LONG_POLLS})`);
        return withRetryAfter(res, LONG_POLL_RETRY_SECONDS);
      }
    }

    const { 0: client, 1: server } = new WebSocketPair();
    // A bridge says where it is reading from up front; a client says so in
    // its `hello`.
    const after = mode === "bridge" ? Number(url.searchParams.get("after") ?? "0") : null;
    const attachment: Attachment = { inbox: name, mode, keyId, pos: after, connectedAt: Date.now() };
    const tags = [`inbox:${name}`, `mode:${mode}`];
    if (keyId) tags.push(`key:${keyId}`);
    this.ctx.acceptWebSocket(server, tags);
    server.serializeAttachment(attachment);
    // An event may have arrived between the Worker's first read and this
    // connection; send it now rather than wait for the next one.
    if (mode === "bridge") this.sendFrom(server, attachment, 1);
    return new Response(null, { status: 101, webSocket: client, headers: responseHeaders });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.open();
    const attachment = ws.deserializeAttachment() as Attachment;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      return send(ws, { type: "error", code: "invalid_request", detail: "messages must be JSON" });
    }
    switch (msg.type) {
      case "hello": {
        const inbox = this.inbox(attachment.inbox);
        if (!inbox) return ws.close(4004, "inbox deleted");
        if (msg.after != null && !(Number.isSafeInteger(msg.after) && msg.after >= 0)) {
          return send(ws, { type: "error", code: "invalid_request", detail: "after must be a non-negative integer" });
        }
        attachment.pos = msg.after ?? inbox.acked;
        ws.serializeAttachment(attachment);
        this.sql.exec("UPDATE inboxes SET last_read_at = ? WHERE name = ?", Date.now(), inbox.name);
        send(ws, { type: "ready", inbox: inbox.name, head: inbox.head, acked: inbox.acked });
        this.sendFrom(ws, attachment);
        return;
      }
      case "ack":
        this.ack(attachment.inbox, msg.seq);
        return;
      default:
        return send(ws, { type: "error", code: "invalid_request", detail: "unknown message type" });
    }
  }

  override async webSocketClose(): Promise<void> {
    // Since compatibility date 2026-04-07 the runtime completes the close
    // handshake itself; nothing else to clean up.
  }

  private push(name: string): void {
    for (const ws of this.ctx.getWebSockets(`inbox:${name}`)) {
      const attachment = ws.deserializeAttachment() as Attachment;
      if (attachment.pos === null) continue;
      // A bridge needs only one batch: the Worker answers and hangs up.
      this.sendFrom(ws, attachment, attachment.mode === "bridge" ? 1 : Infinity);
    }
  }

  // Send everything after the socket's position, in pages.
  private sendFrom(ws: WebSocket, attachment: Attachment, maxPages = Infinity): void {
    for (let page = 0; page < maxPages && attachment.pos !== null; page++) {
      const events = this.eventsAfter(attachment.inbox, attachment.pos, MAX_LIMIT);
      if (!events.length) return;
      send(ws, { type: "events", events });
      const last = events[events.length - 1].seq;
      // Every page should move the position on, but for one starting with
      // the `inbox.gap` that brings a position ahead of `head` back (see
      // eventsAfter); if one doesn't, stop rather than send it forever.
      const back = events[0].kind === "inbox.gap" && events[0].data.missed_after === attachment.pos;
      if (last <= attachment.pos && !back) {
        console.error(`inbox ${attachment.inbox}: a page from ${attachment.pos} ended at ${last}`);
        return;
      }
      attachment.pos = last;
      ws.serializeAttachment(attachment);
    }
  }

  private inbox(name: string): InboxRow | null {
    if (!this.created) return null;
    return this.sql.exec<InboxRow>("SELECT * FROM inboxes WHERE name = ?", name).toArray()[0] ?? null;
  }

  // Up to `limit` events after `after`, leaving out any older than
  // INBOX_MAX_AGE_MS that the alarm hasn't deleted yet. The events kept
  // are consecutive seqs, so a reader is behind them exactly when the
  // first one isn't `after + 1` (or, with none kept, when `after` is
  // before `head`). Such a reader first gets an `inbox.gap`, made here,
  // not stored. It takes the seq just before the first event kept (the
  // last one dropped), so handling it moves the reader past the gap, and
  // asking again from there brings no second one. `head` saves looking up
  // the inbox when the caller has it.
  //
  // A position ahead of `head` was never this inbox's: seqs are never
  // reused (see ensureInbox) and an `ack` past `head` is ignored. Whatever
  // it came from, the reader can't know what it missed, so it gets a gap
  // too, and then everything kept; that gap's seq is below `after`, moving
  // it back.
  private eventsAfter(name: string, after: number, limit: number, head?: number): WatchEvent[] {
    const now = Date.now();
    // Leaving out old events by `at` keeps what's left consecutive only
    // because `at` rises with `seq`.
    const read = (from: number) =>
      this.sql
        .exec<{ body: string }>(
          "SELECT body FROM events WHERE inbox = ? AND seq > ? AND at >= ? ORDER BY seq LIMIT ?",
          name, from, now - INBOX_MAX_AGE_MS, limit,
        )
        .toArray()
        .map((row) => JSON.parse(row.body) as WatchEvent);
    let events = read(after);
    if (events.length && events[0].seq === after + 1) return events;
    const top = head ?? this.inbox(name)?.head ?? 0;
    if (after > top) events = read(0);
    const resumedAt = events.length ? events[0].seq : top + 1;
    if (resumedAt === after + 1) return events;
    return [gapEvent(name, after, resumedAt, now), ...events.slice(0, limit - 1)];
  }
}

// The `inbox.gap` for a reader at `after` whose next event kept is
// `resumedAt`. Its ID is the same however often it's made.
function gapEvent(inbox: string, after: number, resumedAt: number, now: number): WatchEvent {
  const at = new Date(now).toISOString();
  const kind: AccountKind = "inbox.gap";
  return {
    v: 1,
    seq: resumedAt - 1,
    id: `inbox:${inbox}.gap.${after}.${resumedAt}`,
    sub: null,
    kind,
    at,
    received_at: at,
    repo: null,
    pr: null,
    actor: null,
    data: { missed_after: after, resumed_at: resumedAt },
    links: {},
  };
}

function beingDeletedRefusal(): Refusal {
  return { ok: false, status: 409, code: "inbox_deleting", detail: "Inbox is being deleted" };
}

function subscriptionInfo(row: SubscriptionRow): SubscriptionInfo {
  const spec = JSON.parse(row.spec) as Pick<SubscriptionInfo, "kinds" | "ignore" | "base" | "author">;
  return {
    id: row.id,
    inbox: row.inbox,
    repo: { id: row.repo_id, full_name: row.repo_name, private: row.private === 1 },
    pr: row.pr,
    kinds: spec.kinds,
    ...(spec.base === undefined ? {} : { base: spec.base }),
    ...(spec.author === undefined ? {} : { author: spec.author }),
    ignore: spec.ignore,
    created_at: new Date(row.created_at).toISOString(),
    expires_at: new Date(row.expires_at).toISOString(),
    verified_until: row.verified_until === null ? null : new Date(row.verified_until).toISOString(),
    state: "active",
  };
}

function keyInfo(row: KeyRow): KeyInfo {
  return {
    id: row.id,
    label: row.label,
    created_at: new Date(row.created_at).toISOString(),
    last_used_at: row.last_used_at === null ? null : new Date(row.last_used_at).toISOString(),
  };
}

// Completes the handshake, then closes at once with `code`. The socket
// isn't accepted for hibernation, so it's never counted.
function refuseSocket(code: number, reason: string, headers: HeadersInit): Response {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client, headers });
}

function send(ws: WebSocket, msg: ServerMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // The socket closed under us; its close handler will run.
  }
}
