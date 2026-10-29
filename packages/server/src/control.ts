import { DurableObject } from "cloudflare:workers";
import { appJwt, githubHeaders } from "./app";
import { GITHUB_API_URL } from "./github";

// The single object named `control`: global state. For now that's the
// redelivery of missed webhooks, which the cron trigger runs every 10
// minutes. See "Missed deliveries" and "Control" in DESIGN.md.
//
// GitHub lists the App's deliveries newest first, a page at a time. A run
// reads pages until it reaches the cursor (the newest delivery a finished
// scan covered), queues the GUIDs whose deliveries failed and haven't
// since succeeded, then asks GitHub to redeliver a few of them. A scan
// that needs more pages than one run allows carries on from where it
// stopped next run, and so does the queue, so a failed or capped run
// loses nothing.

// Pages of 100 per run, and redelivery requests per run. Each is a
// subrequest (the free plan allows 50 an invocation) and costs a little
// CPU; at ~5,000 webhooks a day a run sees ~35 new deliveries.
export const REDELIVERY_LIMITS = {
  pages: 3,
  redeliveries: 10,
  // Redelivery requests made for one GUID before giving up on it,
  // counting those GitHub refused with a 422 or 5xx.
  attempts: 3,
  // How long one call to GitHub may take, so a hung one can't hold up
  // the run (and every later run, which waits on it) for long.
  timeoutMs: 30_000,
};
const PER_PAGE = 100;
// Deliveries newer than this may still be in flight (GitHub waits 10 s),
// so a scan starts below them and the next run picks them up.
const SETTLE_MS = 60_000;
// With no cursor yet (the first run), how far back to look.
const FIRST_LOOKBACK_MS = 60 * 60_000;
// GitHub keeps deliveries for 3 days; older ones can't be redelivered.
const MAX_AGE_MS = 3 * 24 * 3600_000 - 3600_000;
// Installation events change state that a later one can undo (suspend,
// then unsuspend), so an old failed one isn't redelivered after a newer
// one of the same installation succeeded.
const STATEFUL_EVENT = "installation";
// Events whose order matters, kept in order per installation.
const INSTALLATION_EVENTS = new Set([STATEFUL_EVENT, "installation_repositories"]);
// 422s in a row that stop a run's redeliveries: GitHub may mean the
// whole endpoint ("has been spammed"), not one delivery.
const MAX_422_IN_A_ROW = 2;

// Delivery IDs are int64s, already past 2^53 (3.85e18 in October 2026),
// so they never become JS numbers: the list is parsed with `id` as a
// string (parseDeliveries), and stored and compared as a key of 20
// zero-padded digits, which sorts like the number.
const ID_DIGITS = 20;
const idKey = (id: string) => id.padStart(ID_DIGITS, "0");
const plainId = (key: string) => key.replace(/^0+(?=\d)/, "");

// The table layout, bumped to start over when it changes. 2: delivery
// IDs as text.
const SCHEMA = "2";

// One item of GET /app/hook/deliveries (the fields used here).
interface HookDelivery {
  // Decimal digits; see idKey.
  id: string;
  guid: string;
  delivered_at: string;
  redelivery: boolean;
  status_code: number;
  event: string;
  installation_id: number | null;
}

export interface RedeliveryRun {
  // Pages read, deliveries looked at, and failures newly queued.
  pages: number;
  scanned: number;
  queued: number;
  // Redeliveries GitHub accepted this run, and what's still queued.
  redelivered: number;
  pending: number;
  // True when the scan reached the cursor; false when it carries on.
  caught_up: boolean;
  // Delivery IDs are strings of decimal digits; see idKey.
  cursor: string | null;
  // On a dry run: what would have been redelivered, and wasn't.
  would_redeliver?: { guid: string; delivery_id: string; event: string; status_code: number }[];
  error?: string;
}

export interface ControlStats {
  meta: Record<string, string>;
  queue: { guid: string; delivery_id: string; status_code: number; event: string }[];
  attempts: { guid: string; n: number }[];
}

type QueueRow = {
  guid: string;
  // An idKey.
  delivery_id: string;
  delivered_at: number;
  status_code: number;
  event: string;
  installation_id: number | null;
};

// What's worth redelivering: no response, 429, or a 5xx. The Worker's own
// refusals (401 bad signature, 413 too large, 400 not JSON) would only
// fail again.
export function retryable(statusCode: number): boolean {
  return statusCode < 100 || statusCode === 429 || statusCode >= 500;
}

const succeeded = (statusCode: number) => statusCode >= 200 && statusCode < 400;

const message = (e: unknown) => String(e instanceof Error ? e.message : e);

export class Control extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private running: { dryRun: boolean; done: Promise<RedeliveryRun> } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)");
    // An older layout is dropped, cursor and all: the next run starts
    // afresh, looking back an hour.
    if (this.getMeta("schema") !== SCHEMA) {
      this.sql.exec("DROP TABLE IF EXISTS queue; DROP TABLE IF EXISTS attempts; DROP TABLE IF EXISTS scan_ok; DELETE FROM meta");
      this.setMeta("schema", SCHEMA);
    }
    this.sql.exec(`
      -- meta: schema, cursor, scan_top (idKeys), scan_next, last_run_at,
      -- last_error.
      -- GUIDs to redeliver, each by the failed delivery that queued it
      -- (later failures of the same GUID don't replace it).
      CREATE TABLE IF NOT EXISTS queue (
        guid TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL,
        delivered_at INTEGER NOT NULL,
        status_code INTEGER NOT NULL,
        event TEXT NOT NULL,
        installation_id INTEGER
      );
      -- Redelivery requests made for each GUID, kept while GitHub keeps them.
      CREATE TABLE IF NOT EXISTS attempts (guid TEXT PRIMARY KEY, n INTEGER NOT NULL, last_at INTEGER NOT NULL);
      -- What the scan under way has seen succeed, so that older failures
      -- aren't queued: redelivered GUIDs, and \`installation:<id>\` for an
      -- installation event. Emptied when the scan finishes.
      CREATE TABLE IF NOT EXISTS scan_ok (guid TEXT PRIMARY KEY);
    `);
  }

  // The clock, separate so tests can move it.
  protected now(): number {
    return Date.now();
  }

  // ---- RPC -----------------------------------------------------------

  // One run of the cron job. Runs don't overlap: a call while a run of
  // the same kind is under way gets that run's result, and a call while
  // one of the other kind is under way waits for it, then runs. A dry run
  // scans as usual (so the cursor moves and failures are queued) but
  // redelivers nothing, and lists what it would have redelivered.
  async redeliver(options: { dryRun?: boolean } = {}): Promise<RedeliveryRun> {
    const dryRun = !!options.dryRun;
    while (this.running) {
      if (this.running.dryRun === dryRun) return this.running.done;
      await this.running.done.catch(() => {});
    }
    const done = this.run(dryRun).finally(() => {
      this.running = null;
    });
    this.running = { dryRun, done };
    return done;
  }

  stats(): ControlStats {
    return {
      meta: Object.fromEntries(this.sql.exec<{ k: string; v: string }>("SELECT k, v FROM meta").toArray().map((r) => [r.k, r.v])),
      queue: this.sql
        .exec<QueueRow>("SELECT * FROM queue ORDER BY delivery_id")
        .toArray()
        .map(({ guid, delivery_id, status_code, event }) => ({ guid, delivery_id: plainId(delivery_id), status_code, event })),
      attempts: this.sql.exec<{ guid: string; n: number }>("SELECT guid, n FROM attempts ORDER BY guid").toArray(),
    };
  }

  // ---- The run -------------------------------------------------------

  private async run(dryRun: boolean): Promise<RedeliveryRun> {
    const now = this.now();
    this.setMeta("last_run_at", new Date(now).toISOString());
    this.sql.exec("DELETE FROM attempts WHERE last_at < ?", now - MAX_AGE_MS);
    this.sql.exec("DELETE FROM queue WHERE delivered_at < ?", now - MAX_AGE_MS);
    const result: RedeliveryRun = { pages: 0, scanned: 0, queued: 0, redelivered: 0, pending: 0, caught_up: false, cursor: null };
    let headers: Record<string, string>;
    try {
      headers = githubHeaders(await appJwt(this.env, now));
    } catch (e) {
      return this.finish(result, [message(e)]);
    }
    // Separately, so that GitHub failing to list doesn't hold up what's
    // already queued, and the other way round.
    const errors: string[] = [];
    try {
      await this.scan(now, headers, result);
    } catch (e) {
      errors.push(message(e));
    }
    try {
      if (dryRun) {
        result.would_redeliver = this.due().map(({ guid, delivery_id, event, status_code }) => ({
          guid,
          delivery_id: plainId(delivery_id),
          event,
          status_code,
        }));
      } else {
        await this.redeliverQueued(now, headers, result);
      }
    } catch (e) {
      errors.push(message(e));
    }
    return this.finish(result, errors);
  }

  private finish(result: RedeliveryRun, errors: string[]): RedeliveryRun {
    if (errors.length) {
      const error = errors.join("; ");
      console.error(`redelivery: ${error}`);
      this.setMeta("last_error", error);
      result.error = error;
    } else {
      this.deleteMeta("last_error");
    }
    const cursor = this.cursor();
    result.cursor = cursor === null ? null : plainId(cursor);
    result.pending = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM queue").one().n;
    return result;
  }

  // Reads up to `pages` pages, newest first, from where the last run
  // stopped. State is saved after each page, so a page GitHub fails to
  // serve is simply asked for again next run.
  private async scan(now: number, headers: Record<string, string>, result: RedeliveryRun): Promise<void> {
    const cursor = this.cursor();
    const cutoff = now - (cursor === null ? FIRST_LOOKBACK_MS : MAX_AGE_MS);
    for (let page = 0; page < REDELIVERY_LIMITS.pages; page++) {
      const saved = this.getMeta("scan_next");
      const url = saved ?? `${GITHUB_API_URL}/app/hook/deliveries?per_page=${PER_PAGE}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(REDELIVERY_LIMITS.timeoutMs) });
      if (!res.ok) {
        await res.body?.cancel();
        // GitHub won't take the saved page link (expired, say): start the
        // scan again from the top. The cursor stays, so nothing is skipped.
        if (saved !== null && res.status >= 400 && res.status < 500 && res.status !== 429) this.endScan();
        throw new Error(`listing deliveries: GitHub answered ${res.status}`);
      }
      const items = parseDeliveries(await res.text());
      result.pages++;
      let top = this.getMeta("scan_top");
      let reached = false;
      for (const item of items) {
        const id = idKey(item.id);
        const at = Date.parse(item.delivered_at);
        if ((cursor !== null && id <= cursor) || at < cutoff) {
          reached = true;
          break;
        }
        // Until the scan has a top, skip deliveries that may be in flight.
        if (top === null) {
          if (at > now - SETTLE_MS) continue;
          top = id;
        }
        result.scanned++;
        if (this.classify(item, id, at)) result.queued++;
      }
      const next = nextLink(res.headers.get("Link"));
      if (reached || !next) {
        // The scan is complete: everything up to its top is queued or fine.
        if (top !== null) this.setMeta("cursor", top);
        this.endScan();
        result.caught_up = true;
        return;
      }
      if (top !== null) this.setMeta("scan_top", top);
      this.setMeta("scan_next", next);
    }
  }

  private endScan(): void {
    this.deleteMeta("scan_top");
    this.deleteMeta("scan_next");
    this.sql.exec("DELETE FROM scan_ok");
  }

  // Notes one delivery. Returns true if it queued a new GUID. Most
  // deliveries succeed the first time and write nothing.
  private classify(item: HookDelivery, id: string, at: number): boolean {
    const inst = item.event === STATEFUL_EVENT && item.installation_id !== null ? `installation:${item.installation_id}` : null;
    if (succeeded(item.status_code)) {
      // A GUID that failed and then succeeded did so on a redelivery.
      if (item.redelivery) {
        this.sql.exec("INSERT OR IGNORE INTO scan_ok (guid) VALUES (?)", item.guid);
        this.sql.exec("DELETE FROM queue WHERE guid = ?", item.guid);
      }
      // Only an original delivery is news: a redelivery has a new ID but
      // carries an old event, which mustn't overtake newer ones.
      if (inst && !item.redelivery) {
        this.sql.exec("INSERT OR IGNORE INTO scan_ok (guid) VALUES (?)", inst);
        this.sql.exec("DELETE FROM queue WHERE event = ? AND installation_id = ? AND delivery_id < ?", STATEFUL_EVENT, item.installation_id, id);
      }
      return false;
    }
    if (!retryable(item.status_code)) return false;
    // Newest first, so a later success has been seen already.
    if (this.sql.exec("SELECT 1 FROM scan_ok WHERE guid IN (?, ?)", item.guid, inst ?? "").toArray().length) return false;
    const tried = this.sql.exec<{ n: number }>("SELECT n FROM attempts WHERE guid = ?", item.guid).toArray()[0]?.n ?? 0;
    if (tried >= REDELIVERY_LIMITS.attempts) return false;
    return (
      this.sql.exec(
        "INSERT OR IGNORE INTO queue (guid, delivery_id, delivered_at, status_code, event, installation_id) VALUES (?, ?, ?, ?, ?, ?)",
        item.guid, id, at, item.status_code, item.event, item.installation_id,
      ).rowsWritten > 0
    );
  }

  private due(): QueueRow[] {
    return this.sql.exec<QueueRow>("SELECT * FROM queue ORDER BY delivery_id LIMIT ?", REDELIVERY_LIMITS.redeliveries).toArray();
  }

  // Asks GitHub to redeliver the oldest queued GUIDs, up to the per-run
  // cap. A redelivery GitHub accepts leaves the queue: if it fails too,
  // that shows up as a new failed delivery in a later scan.
  private async redeliverQueued(now: number, headers: Record<string, string>, result: RedeliveryRun): Promise<void> {
    let refusedInARow = 0;
    // Installations with an installation event GitHub refused this run:
    // their later installation events wait, so they stay in order.
    const held = new Set<number>();
    for (const row of this.due()) {
      const ordered = INSTALLATION_EVENTS.has(row.event) && row.installation_id !== null;
      if (ordered && held.has(row.installation_id!)) continue;
      const res = await fetch(`${GITHUB_API_URL}/app/hook/deliveries/${plainId(row.delivery_id)}/attempts`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(REDELIVERY_LIMITS.timeoutMs),
      });
      await res.body?.cancel();
      if (res.status !== 422) refusedInARow = 0;
      if (res.ok) {
        result.redelivered++;
        this.attempted(row.guid, now);
        this.sql.exec("DELETE FROM queue WHERE guid = ?", row.guid);
        continue;
      }
      if (res.status === 400 || res.status === 404) {
        // GitHub won't redeliver it (too old, or gone).
        console.warn(`redelivery of ${row.guid} (${plainId(row.delivery_id)}) refused: ${res.status}`);
        this.sql.exec("DELETE FROM queue WHERE guid = ?", row.guid);
        continue;
      }
      if (res.status === 429) throw new Error(`redelivering ${plainId(row.delivery_id)}: GitHub answered 429`);
      // A 422 (this one refused) or a 5xx counts as an attempt, so one
      // bad row can't hold up the queue for long. A 422 moves on to the
      // next row, unless it's the second in a row; a 5xx is GitHub in
      // trouble, so the rest wait.
      if (this.attempted(row.guid, now) >= REDELIVERY_LIMITS.attempts) {
        console.warn(`redelivery of ${row.guid} (${plainId(row.delivery_id)}) given up: ${res.status}`);
        this.sql.exec("DELETE FROM queue WHERE guid = ?", row.guid);
      }
      if (res.status === 422 && ++refusedInARow < MAX_422_IN_A_ROW) {
        if (ordered) held.add(row.installation_id!);
        continue;
      }
      throw new Error(`redelivering ${plainId(row.delivery_id)}: GitHub answered ${res.status}`);
    }
  }

  // Counts a redelivery request for `guid`; returns how many so far.
  private attempted(guid: string, now: number): number {
    return this.sql
      .exec<{ n: number }>(
        "INSERT INTO attempts (guid, n, last_at) VALUES (?, 1, ?) ON CONFLICT (guid) DO UPDATE SET n = n + 1, last_at = excluded.last_at RETURNING n",
        guid, now,
      )
      .one().n;
  }

  // An idKey.
  private cursor(): string | null {
    return this.getMeta("cursor");
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

// GET /app/hook/deliveries as JSON, with each delivery's `id` kept as
// its digits rather than rounded to a JS number. In JSON text `"id":`
// can't occur inside a string (its quotes would be escaped), and the
// items have no nested objects, so this only touches the IDs.
export function parseDeliveries(text: string): HookDelivery[] {
  const items = JSON.parse(text.replace(/([{,]\s*"id"\s*:\s*)(\d+)/g, '$1"$2"')) as HookDelivery[];
  if (!Array.isArray(items) || items.some((d) => typeof d?.id !== "string" || !/^\d{1,19}$/.test(d.id))) {
    throw new Error("listing deliveries: unexpected response");
  }
  return items;
}

// The rel="next" URL of a Link header, if it points at GitHub's API.
export function nextLink(link: string | null): string | null {
  for (const part of link?.split(",") ?? []) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m && m[1].startsWith(`${GITHUB_API_URL}/`)) return m[1];
  }
  return null;
}
