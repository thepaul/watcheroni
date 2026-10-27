// The two calls to GitHub that use the App's client secret: checking a
// user's token at login, and the refresh proxy. Neither keeps the tokens
// it sees (DESIGN.md, "What the server never stores").

export const GITHUB_WEB_URL = "https://github.com";
export const GITHUB_API_URL = "https://api.github.com";

export type TokenCheck =
  | { ok: true; user: { id: number; login: string } }
  | { ok: false; reason: "invalid" | "unavailable" };

// POST /applications/{client_id}/token answers only for tokens issued to
// this App, so personal access tokens, `gh auth token` and other Apps'
// tokens all come back 404.
export async function checkUserToken(env: Env, token: string): Promise<TokenCheck> {
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API_URL}/applications/${encodeURIComponent(env.GITHUB_CLIENT_ID)}/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "watcheroni",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ access_token: token }),
    });
  } catch (e) {
    console.error("token check failed", e);
    return { ok: false, reason: "unavailable" };
  }
  if (res.status === 404 || res.status === 422) return { ok: false, reason: "invalid" };
  if (!res.ok) {
    // 401 here means our own client ID or secret is wrong.
    console.error(`token check: GitHub answered ${res.status}`);
    return { ok: false, reason: "unavailable" };
  }
  const body = (await res.json()) as { app?: { client_id?: string }; user?: { id?: unknown; login?: unknown } };
  if (body.app?.client_id !== env.GITHUB_CLIENT_ID) return { ok: false, reason: "invalid" };
  const { id, login } = body.user ?? {};
  if (typeof id !== "number" || !Number.isSafeInteger(id) || typeof login !== "string") {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, user: { id, login } };
}

// Adds the client secret to a refresh and passes GitHub's answer back
// unchanged. GitHub reports most failures as 200 with an `error` field.
export async function refreshUserToken(env: Env, refreshToken: string): Promise<Response> {
  const res = await fetch(`${GITHUB_WEB_URL}/login/oauth/access_token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "watcheroni" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  return new Response(res.body, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "no-store" },
  });
}
