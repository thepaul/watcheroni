import { describe, expect, it } from "vitest";
import { ipLimitKey } from "../src/ip";

describe("ipLimitKey", () => {
  it("keeps an IPv4 address as it is", () => {
    expect(ipLimitKey("203.0.113.7")).toBe("203.0.113.7");
    expect(ipLimitKey(" 203.0.113.7 ")).toBe("203.0.113.7");
  });

  it("gives every address in an IPv6 /64 the same key, however it's written", () => {
    for (const ip of [
      "2001:db8:0:1::1",
      "2001:db8:0:1:ffff:ffff:ffff:ffff",
      "2001:0DB8:0000:0001:0000:0000:0000:0042",
      "2001:db8::1:0:0:0:9",
      "2001:db8:0:1:a:b:c:d%eth0",
    ]) {
      expect(ipLimitKey(ip)).toBe("2001:db8:0:1::/64");
    }
    expect(ipLimitKey("2001:db8::")).toBe("2001:db8:0:0::/64");
    expect(ipLimitKey("::1")).toBe("0:0:0:0::/64");
    expect(ipLimitKey("1:2:3:4:5:6:7:8")).toBe("1:2:3:4::/64");
  });

  it("keeps neighbouring /64s apart", () => {
    expect(ipLimitKey("2001:db8:0:1::1")).not.toBe(ipLimitKey("2001:db8:0:2::1"));
    expect(ipLimitKey("2001:db8:1::1")).not.toBe(ipLimitKey("2001:db8:2::1"));
  });

  it("counts an IPv4-mapped IPv6 address as its IPv4 address", () => {
    expect(ipLimitKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipLimitKey("::FFFF:cb00:7107")).toBe("203.0.113.7");
    expect(ipLimitKey("0:0:0:0:0:ffff:203.0.113.7")).toBe("203.0.113.7");
    // An IPv4 tail on an address that isn't mapped is still IPv6.
    expect(ipLimitKey("64:ff9b::203.0.113.7")).toBe("64:ff9b:0:0::/64");
  });

  it("keys anything else by itself", () => {
    for (const ip of ["1:2:3:4:5:6:7:8:9", "1::2::3", "2001:db8::g", "1:2:3:4:5:6:7::8:9", "300.1.1.1", "unknown"]) {
      expect(ipLimitKey(ip)).toBe(ip);
    }
  });
});
