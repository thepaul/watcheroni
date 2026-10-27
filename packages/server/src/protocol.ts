// The parts of PROTOCOL.md this prototype implements. These move to
// packages/protocol once there is a second consumer.

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

export function problem(status: number, code: string, title: string, extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({ type: `https://watcheroni.dev/errors/${code}`, title, status, code, ...extra }),
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
