// Types and constants from PROTOCOL.md, shared by the server, the CLI and
// any other client.

// Event data is shallow metadata. A recursive JSON type would be more
// general but sends TypeScript's RPC type mapping into infinite recursion.
export type DataValue = string | number | boolean | null | string[] | { [key: string]: number };

export interface WatchEvent {
  v: 1;
  seq: number;
  id: string;
  sub: string | null;
  kind: string;
  at: string;
  received_at: string;
  repo: { id: number; full_name: string } | null;
  pr: number | null;
  actor: { id: number; login: string; bot: boolean } | null;
  data: { [key: string]: DataValue };
  links: { html?: string; api?: string };
}

// An event before an inbox has numbered it.
export type UnsequencedEvent = Omit<WatchEvent, "seq">;

export interface EventsPage {
  events: WatchEvent[];
  next: number;
  head: number;
  acked: number;
}

export type ClientMessage =
  | { type: "hello"; after?: number }
  | { type: "ack"; seq: number };

export type ServerMessage =
  | { type: "ready"; inbox: string; head: number; acked: number }
  | { type: "events"; events: WatchEvent[] }
  | { type: "error"; code: string; detail?: string };

export const INBOX_NAME = /^[A-Za-z0-9._-]{1,64}$/;
export const MAX_WAIT_SECONDS = 300;
export const MAX_LIMIT = 500;
export const INBOX_MAX_EVENTS = 1000;

// Kind patterns, as in `--kinds check.*,review.submitted`: an exact kind,
// a prefix ending in `.*`, or `*`. `watch.*` kinds always match, because
// they say the subscription ended.
export function matchesKind(patterns: readonly string[], kind: string): boolean {
  if (!patterns.length || kind.startsWith("watch.")) return true;
  return patterns.some((p) => p === "*" || p === kind || (p.endsWith(".*") && kind.startsWith(p.slice(0, -1))));
}

// GET /v1/meta. Fields a server doesn't have are left out.
export interface Meta {
  protocol: 1;
  server: string;
  features: string[];
  github?: { client_id: string; web_url: string; api_url: string; app_slug?: string; install_url?: string };
  limits: { [name: string]: number };
}

// Authentication (PROTOCOL.md, "Authentication").
export interface LoginRequest {
  github_token: string;
  label?: string;
}

export interface LoginResponse {
  api_key: string;
  key_id: string;
  account: { id: number; login: string };
}

export interface RefreshRequest {
  refresh_token: string;
}

export interface KeyInfo {
  id: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface KeysResponse {
  keys: KeyInfo[];
}

export interface TicketResponse {
  ticket: string;
  url: string;
}

// `wk1_<account id>_<secret>`. Clients treat keys as opaque; this is for
// the server and for telling a key from other strings.
export const API_KEY = /^wk1_(\d{1,20})_([A-Za-z0-9_-]{43})$/;
export const TICKET_TTL_SECONDS = 60;
export const ACCOUNT_REQUESTS_PER_MINUTE = 120;

// Subscriptions (PROTOCOL.md, "Subscriptions").
export interface SubscriptionRequest {
  repo: string;
  pr?: number;
  kinds?: string[];
  // Repository-wide subscriptions only: PRs targeting this branch, or
  // opened by this GitHub login.
  base?: string;
  author?: string;
  ignore?: { self?: boolean; bots?: boolean; actors?: string[] };
  ttl_seconds?: number;
}

export interface SubscriptionInfo {
  id: string;
  inbox: string;
  repo: { id: number; full_name: string; private: boolean };
  pr: number | null;
  kinds: string[];
  // Only when the subscription was made with them.
  base?: string;
  author?: string;
  ignore: { self: boolean; bots: boolean; actors: string[] };
  created_at: string;
  expires_at: string;
  verified_until: string | null;
  state: "active";
  // Only in the answer to creating one.
  baseline?: { state: "open" | "closed" | "merged"; head_sha: string | null; mergeable: "mergeable" | "conflicting" | "unknown" };
}

export interface SubscriptionsResponse {
  subscriptions: SubscriptionInfo[];
}

export const DEFAULT_TTL_SECONDS = 7 * 24 * 3600;
export const MAX_TTL_SECONDS = 30 * 24 * 3600;
export const PRIVATE_VERIFY_SECONDS = 7 * 24 * 3600;
export const ACCOUNT_MAX_SUBSCRIPTIONS = 200;

// The other per-account caps (PROTOCOL.md, "Limits"). Each is far above
// what one person uses, and there to bound what a leaked or misbehaving key
// can hold open or store.
//
// Inboxes: the CLI makes one per Claude Code session that watches
// something. One nobody has read for INBOX_IDLE_DAYS, with no
// subscriptions or connections left, is deleted to make room, so this
// allows about 16 new sessions a day, every day.
export const ACCOUNT_MAX_INBOXES = 500;
export const INBOX_IDLE_DAYS = 30;
// Live keys: one per machine signed in, plus scripts and bots.
export const ACCOUNT_MAX_KEYS = 100;
// Open WebSockets: one per running `watcheroni wait` or `watch`, so one
// per busy session.
export const ACCOUNT_MAX_SOCKETS = 50;
// Long polls waiting at once: what clients that can't open a WebSocket
// use instead, so the same number. Without it, the request budget allows
// about 600, each held for up to MAX_WAIT_SECONDS.
export const ACCOUNT_MAX_LONG_POLLS = 50;
