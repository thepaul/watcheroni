// API keys and WebSocket tickets (DESIGN.md, "API keys and tickets").
// Everything here is pure: no storage, no network.

import { API_KEY, TICKET_TTL_SECONDS } from "./protocol";

const encoder = new TextEncoder();

// A new key for an account. Only `hash` is ever stored; `key` is shown to
// the user once.
export async function newApiKey(accountId: number): Promise<{ key: string; hash: ArrayBuffer }> {
  const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
  return { key: `wk1_${accountId}_${secret}`, hash: await sha256(secret) };
}

// Splits a key into the account it belongs to and the hash to look up.
// Null if it isn't shaped like a key.
export async function parseApiKey(key: string): Promise<{ accountId: number; hash: ArrayBuffer } | null> {
  const m = API_KEY.exec(key);
  if (!m) return null;
  const accountId = Number(m[1]);
  if (!Number.isSafeInteger(accountId)) return null;
  return { accountId, hash: await sha256(m[2]) };
}

export function bearer(request: Request): string | null {
  const header = request.headers.get("Authorization");
  return header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

// `key_` and a ULID: sortable by creation time, which is how keys list.
export function newKeyId(now = Date.now()): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = "";
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = alphabet[t % 32] + time;
  const random = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => alphabet[b % 32]).join("");
  return `key_${time}${random}`;
}

export interface TicketPayload {
  acct: number;
  inbox: string;
  key: string;
  exp: number; // Unix seconds
  nonce: string;
}

export function newTicketPayload(acct: number, inbox: string, key: string, now = Date.now()): TicketPayload {
  return { acct, inbox, key, exp: Math.floor(now / 1000) + TICKET_TTL_SECONDS, nonce: crypto.randomUUID() };
}

// `wt1.<base64url JSON payload>.<base64url HMAC-SHA256 of "wt1.<payload>">`
export async function signTicket(payload: TicketPayload, secret: string): Promise<string> {
  const body = `wt1.${base64url(encoder.encode(JSON.stringify(payload)))}`;
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body));
  return `${body}.${base64url(new Uint8Array(mac))}`;
}

// Checks the signature against each configured key (the current one and,
// during rotation, the old one) and the expiry. Single use is the Account
// object's job, since it needs storage.
export async function verifyTicket(
  ticket: string,
  secrets: (string | undefined)[],
  now = Date.now(),
): Promise<TicketPayload | null> {
  const parts = ticket.split(".");
  if (parts.length !== 3 || parts[0] !== "wt1") return null;
  const mac = fromBase64url(parts[2]);
  if (!mac) return null;
  const body = encoder.encode(`${parts[0]}.${parts[1]}`);
  let valid = false;
  for (const secret of secrets) {
    if (secret && (await crypto.subtle.verify("HMAC", await hmacKey(secret), mac, body))) {
      valid = true;
      break;
    }
  }
  if (!valid) return null;
  let payload: TicketPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64url(parts[1])!));
  } catch {
    return null;
  }
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) return null;
  return payload;
}

export async function sha256(s: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(s));
}

// Constant-time comparison of two secrets of any length.
export async function secretsEqual(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(s: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
