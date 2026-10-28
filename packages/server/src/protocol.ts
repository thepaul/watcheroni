// The protocol's types live in @watcheroni/protocol; this adds the
// server's response helpers.
export * from "@watcheroni/protocol";

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

export function withRetryAfter(res: Response, seconds: number): Response {
  res.headers.set("Retry-After", String(seconds));
  return res;
}

export async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}
