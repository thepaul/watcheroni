// What the per-IP limits count by: an IPv4 address as it is, and an IPv6
// address by its /64, since anyone with an IPv6 connection usually has a
// whole /64 and could otherwise take a new address for every request.

// The key for `ip` (CF-Connecting-IP): "203.0.113.7", or "2001:db8:0:0::/64"
// for any address in that /64. An IPv4-mapped IPv6 address
// (::ffff:203.0.113.7) counts as its IPv4 address. Anything unparseable is
// its own key, lowercased.
export function ipLimitKey(ip: string): string {
  ip = ip.trim().toLowerCase();
  if (isIPv4(ip)) return ip;
  const hextets = parseIPv6(ip.replace(/%.*$/, ""));
  if (!hextets) return ip;
  if (hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff) {
    return [hextets[6] >> 8, hextets[6] & 0xff, hextets[7] >> 8, hextets[7] & 0xff].join(".");
  }
  return `${hextets.slice(0, 4).map((h) => h.toString(16)).join(":")}::/64`;
}

function isIPv4(s: string): boolean {
  const parts = s.split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

// Eight 16-bit numbers, or null if `s` isn't an IPv6 address.
function parseIPv6(s: string): number[] | null {
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (half: string) => (half === "" ? [] : half.split(":"));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  // A dotted IPv4 address may stand for the last two hextets.
  const all = [...head, ...tail];
  const last = all[all.length - 1];
  if (last?.includes(".")) {
    if (!isIPv4(last)) return null;
    const [a, b, c, d] = last.split(".").map(Number);
    const pair = [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
    (tail.length ? tail : head).splice(-1, 1, ...pair);
  }
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const full = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (!full.every((h) => /^[0-9a-f]{1,4}$/.test(h))) return null;
  return full.map((h) => parseInt(h, 16));
}
