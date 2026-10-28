import { DurableObject } from "cloudflare:workers";
import { mintInstallationToken } from "./app";
import { BUCKETS_TABLE, msUntil, take, type BucketSpec } from "./limits";

// One per App installation, named `inst:<installation.id>`. Caches the
// installation token (encrypted with STORAGE_KEY), holds the
// installation-wide GitHub API budget, and ends the watches on its repos
// when it's uninstalled, suspended or loses repos. See "Installation" in
// DESIGN.md.

export const INSTALLATION_LIMITS = {
  // GitHub API calls made by the server: 1,000 an hour (GitHub allows 5,000).
  api: { capacity: 1000, perSecond: 1000 / 3600 } satisfies BucketSpec,
};

// A cached token is used while it has more than this left.
const TOKEN_MARGIN_MS = 5 * 60_000;
// RepoHubs told inline about a revocation; the alarm does the rest, so
// each invocation stays well inside the subrequest limit.
export const REVOKE_BATCH = 20;
const RETRY_FIRST_MS = 5_000;
const RETRY_MAX_MS = 10 * 60_000;
const REVOKE_ATTEMPTS = 12;

// What the Worker takes from `installation` and `installation_repositories`
// webhooks.
export interface InstallationFact {
  id: number;
  // created, deleted, suspend, unsuspend, new_permissions_accepted
  // (installation); added, removed (installation_repositories).
  action: string;
  account: { login: string; type: string } | null;
  repository_selection: string | null;
  repos_removed: number[];
}

export type TokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: "not_installed" | "unavailable" }
  | { ok: false; reason: "rate_limited"; retry_after: number };

export interface InstallationStats {
  meta: Record<string, string>;
  repos: number[];
  revocations: { repo_id: number; reason: string; attempts: number }[];
  token_expires_at: number | null;
}

type TokenRow = { ciphertext: ArrayBuffer; iv: ArrayBuffer; expires_at: number };
type RevocationRow = { repo_id: number; reason: string; event_base: string; attempts: number };

export class Installation extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  // The token, kept in memory too while the object stays loaded.
  private memo: { token: string; expiresAt: number } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS token (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        ciphertext BLOB NOT NULL, iv BLOB NOT NULL, expires_at INTEGER NOT NULL
      );
      -- Repos that have had /v1 subscriptions through this installation,
      -- so an uninstall can end their watches even when GitHub's payload
      -- doesn't list the repos.
      CREATE TABLE IF NOT EXISTS repos (id INTEGER PRIMARY KEY, added_at INTEGER NOT NULL);
      -- RepoHubs still to be told that their watches are revoked.
      CREATE TABLE IF NOT EXISTS revocations (
        repo_id INTEGER PRIMARY KEY,
        reason TEXT NOT NULL,
        event_base TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL
      );
      ${BUCKETS_TABLE}
    `);
  }

  // The clock, separate so tests can move it.
  protected now(): number {
    return Date.now();
  }

  // ---- RPC -----------------------------------------------------------

  // An installation token, after taking `calls` from the API budget for
  // the calls the caller is about to make with it.
  async token(installationId: number, calls = 0): Promise<TokenResult> {
    this.setMeta("id", String(installationId));
    if (this.getMeta("deleted_at") || this.getMeta("suspended_at")) return { ok: false, reason: "not_installed" };
    const now = this.now();
    if (calls > 0 && !this.spend(calls)) {
      const wait = msUntil(this.sql, "api", INSTALLATION_LIMITS.api, now, calls);
      return { ok: false, reason: "rate_limited", retry_after: Math.ceil(wait / 1000) };
    }
    if (this.memo && this.memo.expiresAt - now > TOKEN_MARGIN_MS) return { ok: true, token: this.memo.token };
    const stored = await this.loadToken();
    if (stored && stored.expiresAt - now > TOKEN_MARGIN_MS) {
      this.memo = stored;
      return { ok: true, token: stored.token };
    }
    const minted = await mintInstallationToken(this.env, installationId);
    if (!minted.ok) {
      // GitHub says the installation is gone or suspended, perhaps before
      // its webhook arrived.
      if (minted.reason !== "unavailable") this.setMeta(minted.reason === "gone" ? "deleted_at" : "suspended_at", String(now));
      return { ok: false, reason: minted.reason === "unavailable" ? "unavailable" : "not_installed" };
    }
    this.memo = { token: minted.token, expiresAt: minted.expiresAt };
    await this.storeToken(this.memo);
    return { ok: true, token: minted.token };
  }

  // Takes `calls` from the installation-wide GitHub API budget.
  spend(calls: number): boolean {
    return take(this.sql, "api", INSTALLATION_LIMITS.api, this.now(), calls);
  }

  // Notes a repo that now has subscriptions through this installation.
  addRepo(repoId: number): void {
    this.sql.exec("INSERT OR IGNORE INTO repos (id, added_at) VALUES (?, ?)", repoId, this.now());
  }

  // From `installation` and `installation_repositories` webhooks. Returns
  // how many repos' watches were ended now, and how many are left to the
  // alarm.
  async onEvent(fact: InstallationFact, delivery: string): Promise<{ revoked: number; queued: number }> {
    const now = this.now();
    this.setMeta("id", String(fact.id));
    if (fact.account) {
      this.setMeta("account_login", fact.account.login);
      this.setMeta("account_type", fact.account.type);
    }
    if (fact.repository_selection) this.setMeta("repository_selection", fact.repository_selection);

    let ending: number[] = [];
    let reason = "";
    switch (fact.action) {
      case "created":
      case "unsuspend":
      case "new_permissions_accepted":
        this.deleteMeta("deleted_at");
        this.deleteMeta("suspended_at");
        break;
      case "deleted":
      case "suspend":
        this.setMeta(fact.action === "deleted" ? "deleted_at" : "suspended_at", String(now));
        this.sql.exec("DELETE FROM token");
        this.memo = null;
        ending = this.sql.exec<{ id: number }>("SELECT id FROM repos").toArray().map((r) => r.id);
        reason = fact.action === "deleted" ? "uninstalled" : "suspended";
        break;
      case "removed":
        ending = this.sql
          .exec<{ id: number }>("SELECT id FROM repos WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(fact.repos_removed))
          .toArray()
          .map((r) => r.id);
        reason = "removed";
        break;
    }
    for (const repo of ending) {
      this.sql.exec("DELETE FROM repos WHERE id = ?", repo);
      this.sql.exec(
        "INSERT INTO revocations (repo_id, reason, event_base, next_at) VALUES (?, ?, ?, ?) ON CONFLICT (repo_id) DO NOTHING",
        repo, reason, delivery, now,
      );
    }
    const revoked = await this.revokeDue(now);
    return { revoked, queued: this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM revocations").one().n };
  }

  stats(): InstallationStats {
    const meta = Object.fromEntries(
      this.sql.exec<{ k: string; v: string }>("SELECT k, v FROM meta").toArray().map((r) => [r.k, r.v]),
    );
    return {
      meta,
      repos: this.sql.exec<{ id: number }>("SELECT id FROM repos ORDER BY id").toArray().map((r) => r.id),
      revocations: this.sql.exec<RevocationRow>("SELECT * FROM revocations ORDER BY repo_id").toArray()
        .map(({ repo_id, reason, attempts }) => ({ repo_id, reason, attempts })),
      token_expires_at: this.sql.exec<{ expires_at: number }>("SELECT expires_at FROM token").toArray()[0]?.expires_at ?? null,
    };
  }

  override async alarm(): Promise<void> {
    await this.revokeDue(this.now());
  }

  // ---- Revocations ---------------------------------------------------

  // Tells up to REVOKE_BATCH RepoHubs to end their watches, retrying
  // failures with backoff. Returns how many succeeded.
  private async revokeDue(now: number): Promise<number> {
    const rows = this.sql
      .exec<RevocationRow>("SELECT * FROM revocations WHERE next_at <= ? ORDER BY next_at LIMIT ?", now, REVOKE_BATCH)
      .toArray();
    const results = await Promise.allSettled(rows.map((r) => this.revokeRepo(r.repo_id, r.reason, r.event_base)));
    let done = 0;
    results.forEach((result, i) => {
      const row = rows[i];
      const attempts = row.attempts + 1;
      if (result.status === "fulfilled" || attempts >= REVOKE_ATTEMPTS) {
        if (result.status === "rejected") console.error(`revoking repo ${row.repo_id} gave up: ${result.reason}`);
        else done++;
        this.sql.exec("DELETE FROM revocations WHERE repo_id = ?", row.repo_id);
        return;
      }
      const backoff = Math.min(RETRY_FIRST_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
      this.sql.exec("UPDATE revocations SET attempts = ?, next_at = ? WHERE repo_id = ?", attempts, now + backoff, row.repo_id);
    });
    const next = this.sql.exec<{ t: number | null }>("SELECT MIN(next_at) AS t FROM revocations").one().t;
    if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, now));
    else await this.ctx.storage.deleteAlarm();
    return done;
  }

  // Separate so tests can make a RepoHub fail.
  protected async revokeRepo(repoId: number, reason: string, eventBase: string): Promise<void> {
    await this.env.REPO_HUB.get(this.env.REPO_HUB.idFromName(`repo:${repoId}`)).revokeAll(reason, eventBase);
  }

  // ---- The cached token ----------------------------------------------

  private async loadToken(): Promise<{ token: string; expiresAt: number } | null> {
    const row = this.sql.exec<TokenRow>("SELECT ciphertext, iv, expires_at FROM token").toArray()[0];
    const key = row && (await storageKey(this.env));
    if (!row || !key) return null;
    try {
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: row.iv }, key, row.ciphertext);
      return { token: new TextDecoder().decode(plain), expiresAt: row.expires_at };
    } catch {
      // STORAGE_KEY changed since; mint a new token.
      return null;
    }
  }

  // Without STORAGE_KEY the token is kept only in memory: storing it in
  // the clear would defeat the point.
  private async storeToken({ token, expiresAt }: { token: string; expiresAt: number }): Promise<void> {
    const key = await storageKey(this.env);
    if (!key) return;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(token));
    this.sql.exec(
      "INSERT INTO token (id, ciphertext, iv, expires_at) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, expires_at = excluded.expires_at",
      ciphertext, iv.buffer, expiresAt,
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

// STORAGE_KEY: 32 random bytes in base64 (`openssl rand -base64 32`).
let cachedStorageKey: { secret: string; key: Promise<CryptoKey | null> } | null = null;

function storageKey(env: Env): Promise<CryptoKey | null> {
  const secret = env.STORAGE_KEY ?? "";
  if (cachedStorageKey?.secret !== secret) cachedStorageKey = { secret, key: importStorageKey(secret) };
  return cachedStorageKey.key;
}

async function importStorageKey(secret: string): Promise<CryptoKey | null> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));
  } catch {
    raw = new Uint8Array();
  }
  if (raw.length !== 32) {
    console.warn("STORAGE_KEY isn't 32 bytes of base64; installation tokens are cached in memory only");
    return null;
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
