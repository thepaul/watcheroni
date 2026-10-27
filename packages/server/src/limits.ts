// Token buckets kept in a Durable Object's SQLite `buckets` table, refilled
// by elapsed time when read. See "Limits" in DESIGN.md.

export interface BucketSpec {
  capacity: number;
  perSecond: number;
}

export const BUCKETS_TABLE = `
  CREATE TABLE IF NOT EXISTS buckets (
    name TEXT PRIMARY KEY,
    tokens REAL NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

// The bucket's level at `now`, without changing it.
export function level(sql: SqlStorage, name: string, spec: BucketSpec, now: number): number {
  const row = sql
    .exec<{ tokens: number; updated_at: number }>("SELECT tokens, updated_at FROM buckets WHERE name = ?", name)
    .toArray()[0];
  if (!row) return spec.capacity;
  const elapsed = Math.max(0, now - row.updated_at) / 1000;
  return Math.min(spec.capacity, row.tokens + elapsed * spec.perSecond);
}

// Takes one token if there is one. Returns whether it did.
export function take(sql: SqlStorage, name: string, spec: BucketSpec, now: number): boolean {
  let tokens = level(sql, name, spec, now);
  const ok = tokens >= 1;
  if (ok) tokens -= 1;
  sql.exec(
    "INSERT INTO buckets (name, tokens, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at",
    name, tokens, now,
  );
  return ok;
}

// Milliseconds until the bucket holds `target` tokens.
export function msUntil(sql: SqlStorage, name: string, spec: BucketSpec, now: number, target: number): number {
  const missing = Math.min(target, spec.capacity) - level(sql, name, spec, now);
  return missing <= 0 ? 0 : Math.ceil((missing / spec.perSecond) * 1000);
}
