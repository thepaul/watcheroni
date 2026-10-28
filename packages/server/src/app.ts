// Calls to GitHub as the App itself: App JWTs (RS256, signed with
// GITHUB_APP_PRIVATE_KEY), finding a repo's installation, and minting
// installation tokens. See "Credentials" in DESIGN.md.

import { base64url } from "./auth";
import { GITHUB_API_URL } from "./github";

const encoder = new TextEncoder();
// GitHub allows App JWTs up to 10 minutes. Backdating covers clock skew.
const JWT_BACKDATE_SECONDS = 60;
const JWT_TTL_SECONDS = 9 * 60;

export function githubHeaders(token: string, scheme = "Bearer"): Record<string, string> {
  return {
    Authorization: `${scheme} ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "watcheroni",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// Imported once per isolate, and again only if the secret changes.
let cachedKey: { pem: string; key: Promise<CryptoKey> } | null = null;

function signingKey(pem: string): Promise<CryptoKey> {
  if (cachedKey?.pem !== pem) cachedKey = { pem, key: importPkcs8(pem) };
  return cachedKey.key;
}

async function importPkcs8(pem: string): Promise<CryptoKey> {
  // Pasted secrets sometimes keep their newlines as `\n`.
  const text = pem.replace(/\\n/g, "\n");
  if (text.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error("GITHUB_APP_PRIVATE_KEY is PKCS#1; convert it with `openssl pkcs8 -topk8 -nocrypt`");
  }
  const body = text.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

// A JWT that authenticates as the App, valid for 9 minutes. Never stored.
export async function appJwt(env: Env, now = Date.now()): Promise<string> {
  if (!env.GITHUB_APP_PRIVATE_KEY || !env.GITHUB_APP_ID) throw new Error("the GitHub App isn't configured");
  const iat = Math.floor(now / 1000) - JWT_BACKDATE_SECONDS;
  const part = (o: object) => base64url(encoder.encode(JSON.stringify(o)));
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat, exp: iat + JWT_BACKDATE_SECONDS + JWT_TTL_SECONDS, iss: env.GITHUB_APP_ID })}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await signingKey(env.GITHUB_APP_PRIVATE_KEY), encoder.encode(unsigned));
  return `${unsigned}.${base64url(new Uint8Array(sig))}`;
}

export type InstallationLookup =
  | { ok: true; id: number }
  | { ok: false; reason: "not_installed" | "unavailable" };

// GET /repos/{owner}/{repo}/installation. GitHub answers 404 both for a
// repo the App isn't installed on and for one that doesn't exist, so the
// two look the same to a caller, which is what we want.
export async function findInstallation(env: Env, owner: string, repo: string): Promise<InstallationLookup> {
  try {
    const res = await fetch(`${GITHUB_API_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`, {
      headers: githubHeaders(await appJwt(env)),
    });
    if (res.status === 404) return { ok: false, reason: "not_installed" };
    if (!res.ok) {
      console.error(`installation lookup for ${owner}/${repo}: GitHub answered ${res.status}`);
      return { ok: false, reason: "unavailable" };
    }
    const { id } = (await res.json()) as { id?: unknown };
    return typeof id === "number" ? { ok: true, id } : { ok: false, reason: "unavailable" };
  } catch (e) {
    console.error(`installation lookup for ${owner}/${repo} failed`, e);
    return { ok: false, reason: "unavailable" };
  }
}

export type MintResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; reason: "gone" | "suspended" | "unavailable" };

// POST /app/installations/{id}/access_tokens: a read-only token for that
// installation's repos, valid for an hour.
export async function mintInstallationToken(env: Env, installationId: number): Promise<MintResult> {
  try {
    const res = await fetch(`${GITHUB_API_URL}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: githubHeaders(await appJwt(env)),
    });
    if (res.status === 404) return { ok: false, reason: "gone" };
    if (res.status === 403) return { ok: false, reason: "suspended" };
    if (!res.ok) {
      console.error(`installation ${installationId} token: GitHub answered ${res.status}`);
      return { ok: false, reason: "unavailable" };
    }
    const body = (await res.json()) as { token?: unknown; expires_at?: unknown };
    const expiresAt = Date.parse(String(body.expires_at));
    if (typeof body.token !== "string" || !Number.isFinite(expiresAt)) return { ok: false, reason: "unavailable" };
    return { ok: true, token: body.token, expiresAt };
  } catch (e) {
    console.error(`installation ${installationId} token failed`, e);
    return { ok: false, reason: "unavailable" };
  }
}
