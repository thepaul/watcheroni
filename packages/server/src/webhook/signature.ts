// Checks GitHub's X-Hub-Signature-256 header: "sha256=" and the hex
// HMAC-SHA256 of the raw body. Accepts any of the given secrets, so the
// webhook secret can be rotated without dropping deliveries.

const encoder = new TextEncoder();

export async function verifySignature(
  body: ArrayBuffer,
  header: string | null,
  secrets: (string | undefined)[],
): Promise<boolean> {
  const signature = header?.startsWith("sha256=") ? hexBytes(header.slice(7)) : null;
  if (!signature || signature.length !== 32) return false;
  for (const secret of secrets) {
    if (!secret) continue;
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
    );
    // subtle.verify compares in constant time.
    if (await crypto.subtle.verify("HMAC", key, signature, body)) return true;
  }
  return false;
}

// What GitHub sends, for tests and tools that sign payloads themselves.
export async function sign(body: ArrayBuffer | Uint8Array, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  return "sha256=" + Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
