// Origin policy evaluator: grammar validation, wildcard/apex matching, port
// normalization, and deny > allow > default precedence. Pure layer -- no UI,
// no filesystem, no network.

import { describe, it, expect } from "bun:test";
import { ConfigError } from "@core/error.ts";
import {
  compileFetchPolicy,
  decideOrigin,
  originOf,
  parseOriginRule,
  type FetchPolicyRules,
  type Origin,
  type OriginVerdict,
} from "@utils/fetch-policy/policy.ts";

function rules(over: { default?: OriginVerdict; allow?: string[]; deny?: string[] } = {}): FetchPolicyRules {
  return compileFetchPolicy({ default: "ask", ...over });
}

function origin(url: string): Origin {
  const o = originOf(url);
  if (!o) throw new Error(`originOf returned null for ${url}`);
  return o;
}

describe("parseOriginRule", () => {
  it("parses scheme, host, and the scheme default port", () => {
    const r = parseOriginRule("https://api.github.com");
    expect(r.raw).toBe("https://api.github.com");
    expect(r.apex).toBeNull();
    expect(r.port).toBe(443);
    expect(r.schemeRe.test("https")).toBe(true);
    expect(r.hostRe.test("api.github.com")).toBe(true);
  });

  it("captures the bare apex companion of a '*.' host pattern", () => {
    expect(parseOriginRule("https://*.example.com").apex).toBe("example.com");
    expect(() => parseOriginRule("https://*.example.com?x=1")).toThrow(ConfigError); // '?' refused, not a glob
  });

  it("accepts explicit ports, ':*', globbed schemes, and IPv6 literals", () => {
    expect(parseOriginRule("*://cdn.example.com:8080").port).toBe(8080);
    expect(parseOriginRule("https://example.com:*").port).toBe("*");
    expect(parseOriginRule("*://example.com").port).toBe("*");
    const v6 = parseOriginRule("https://[::1]:8443");
    expect(v6.hostRe.test("::1")).toBe(true);
    expect(v6.port).toBe(8443);
    expect(parseOriginRule("https://[::1]").port).toBe(443);
    expect(parseOriginRule("smb://files:445").port).toBe(445);
  });

  it("normalizes case and a trailing dot", () => {
    const r = parseOriginRule("HTTPS://API.Example.COM.");
    expect(r.hostRe.test("api.example.com")).toBe(true);
  });

  it("rejects malformed entries loudly", () => {
    expect(() => parseOriginRule("example.com")).toThrow(ConfigError); // no scheme
    expect(() => parseOriginRule("https://example.com/path")).toThrow(ConfigError); // path
    expect(() => parseOriginRule("https://example.com/")).toThrow(ConfigError); // trailing slash
    expect(() => parseOriginRule("https://example.com:abc")).toThrow(ConfigError);
    expect(() => parseOriginRule("https://example.com:99999")).toThrow(ConfigError);
    expect(() => parseOriginRule("smb://files")).toThrow(ConfigError); // unknown scheme, no default port
    expect(() => parseOriginRule("https://[::1")).toThrow(ConfigError); // unbalanced brackets
    expect(() => parseOriginRule("https://")).toThrow(ConfigError); // empty host
    expect(() => parseOriginRule("")).toThrow(ConfigError);
    expect(() => parseOriginRule(42)).toThrow(ConfigError);
    expect(() => parseOriginRule("https:/example.com")).toThrow(ConfigError); // single slash
  });
});

describe("originOf", () => {
  it("reduces a URL to its canonical origin", () => {
    const o = origin("https://api.github.com/repos/x?query=1#frag");
    expect(o.origin).toBe("https://api.github.com");
    expect(o.port).toBe(443);
    expect(origin("https://api.github.com:443/x").origin).toBe("https://api.github.com");
    expect(origin("http://example.com:8080/").origin).toBe("http://example.com:8080");
    expect(origin("ftp://files.example.com/pub/readme").origin).toBe("ftp://files.example.com");
  });

  it("never carries credential userinfo", () => {
    expect(origin("https://user:pw@example.com/").origin).toBe("https://example.com");
  });

  it("handles IPv6, uppercase, and trailing-dot hosts", () => {
    const v6 = origin("https://[::1]:8443/x");
    expect(v6.host).toBe("::1");
    expect(v6.origin).toBe("https://[::1]:8443");
    expect(origin("HTTPS://EXAMPLE.COM/x").host).toBe("example.com");
    expect(origin("https://example.com./x").origin).toBe("https://example.com");
  });

  it("returns null for unusable targets", () => {
    expect(originOf("not a url")).toBeNull();
    expect(originOf("https://")).toBeNull();
    expect(originOf("custom://host")).toBeNull(); // unknown scheme, no port story
    expect(originOf("mailto:someone@example.com")).toBeNull(); // no host
  });
});

describe("decideOrigin", () => {
  it("deny beats allow", () => {
    const r = rules({
      deny: ["*://*.example.com"],
      allow: ["https://api.example.com"],
      default: "allow",
    });
    const d = decideOrigin(origin("https://api.example.com/v1"), r);
    expect(d.verdict).toBe("deny");
    expect(d.matched).toEqual(["*://*.example.com"]);
  });

  it("matches allows and names the rule", () => {
    const r = rules({ allow: ["https://*.example.com"], default: "deny" });
    expect(decideOrigin(origin("https://example.com"), r).verdict).toBe("allow"); // apex companion
    expect(decideOrigin(origin("https://a.b.example.com"), r).verdict).toBe("allow");
    expect(decideOrigin(origin("https://evil-example.com"), r).verdict).toBe("deny"); // default
    expect(decideOrigin(origin("http://example.com"), r).verdict).toBe("deny"); // wrong scheme
  });

  it("ports are specific unless '*' is written", () => {
    const strict = rules({ allow: ["https://example.com"], default: "deny" });
    expect(decideOrigin(origin("https://example.com:8443/x"), strict).verdict).toBe("deny");
    const loose = rules({ allow: ["https://example.com:*"], default: "deny" });
    expect(decideOrigin(origin("https://example.com:8443/x"), loose).verdict).toBe("allow");
  });

  it("falls to the default with a readable reason", () => {
    for (const def of ["allow", "ask", "deny"] as const) {
      const d = decideOrigin(origin("https://unknown.example"), rules({ default: def }));
      expect(d.verdict).toBe(def);
      expect(d.matched).toEqual([]);
      expect(d.reasons[0]).toContain(`fetchPolicy.default is "${def}"`);
    }
  });

  it("a '*' host matches every host under the scheme, ports still bind", () => {
    const r = rules({ allow: ["https://*"] });
    expect(decideOrigin(origin("https://anything.at.all.example/x"), r).verdict).toBe("allow");
    expect(decideOrigin(origin("https://[::1]:8443/x"), r).verdict).toBe("ask"); // rule is :443 only
  });
});

describe("compileFetchPolicy", () => {
  it("validates the resolved block", () => {
    expect(() => compileFetchPolicy(undefined as never)).toThrow(ConfigError);
    expect(() => compileFetchPolicy({} as never)).toThrow(ConfigError); // missing default
    expect(() => compileFetchPolicy({ default: "sometimes" } as never)).toThrow(ConfigError);
    expect(() => compileFetchPolicy({ default: "ask", allow: "x" } as never)).toThrow(ConfigError);
    expect(() => compileFetchPolicy({ default: "ask", deny: ["nope"] })).toThrow(ConfigError);
  });
});
