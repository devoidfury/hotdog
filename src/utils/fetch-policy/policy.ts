// Origin policy evaluator -- decision layer for the fetch-policy extension.
// @see docs/config-reference.md "fetchPolicy"
//
// Grammar: `scheme://host[:port]`. `*` globs scheme, host, and port
// (`https://*.example.com`, `*://cdn.example.com:8080`, `:*` for any port).
// `?` is NOT a glob here -- it would be ambiguous with a query delimiter, so
// single-char globs are refused at parse. A host pattern starting with `*.`
// ALSO matches the bare apex (`*.example.com` covers `example.com` and
// `a.b.example.com`, never `evil-example.com`). An omitted port means the
// scheme's default port; `:*` means any port.
// No path: origin is scheme+host+port. Path-scoping on HTTPS is impossible
// without MITM, so the grammar refuses to imply it (`https://example.com/x`
// is a config error, not a silently-ignored rule).
//
// Precedence: deny > allow > fetchPolicy.default ("allow" | "ask" | "deny").
//
// Pure layer: no UI, no filesystem, no network. The caller merges the config
// lists with the persisted state file before compiling.

import { isIP } from "node:net";
import { ConfigError } from "@core/error.ts";

export type OriginVerdict = "allow" | "ask" | "deny";

/** Schemes with an unambiguous default port for rules that omit one. */
const DEFAULT_PORTS: Record<string, number> = {
  http: 80,
  https: 443,
  ws: 80,
  wss: 443,
  ftp: 21,
};

/** A request target reduced to what an origin rule can match. */
export interface Origin {
  scheme: string;
  /** Hostname or IP literal, brackets stripped. */
  host: string;
  /** Effective port. */
  port: number;
  /** Canonical `scheme://host[:port]`; IPv6 bracketed, default port omitted. Never carries userinfo. */
  origin: string;
}

export interface FetchPolicyRule {
  /** The raw config entry, for messages and hints. */
  raw: string;
  schemeRe: RegExp;
  hostRe: RegExp;
  /** Bare-apex companion of a `*.` pattern (matched in addition to hostRe). */
  apex: string | null;
  port: number | "*";
}

export interface FetchPolicyRules {
  default: OriginVerdict;
  allow: FetchPolicyRule[];
  deny: FetchPolicyRule[];
}

/** The RESOLVED fetchPolicy block the schema guarantees (hand-built callers supply `default` explicitly). */
export interface ResolvedFetchPolicyConfig {
  default: OriginVerdict;
  allow?: string[];
  deny?: string[];
}

export interface OriginDecision {
  verdict: OriginVerdict;
  /** Raw rule entries that matched (empty for a default verdict). */
  matched: string[];
  reasons: string[];
}

/** `*` = anything (crossing dots). Hosts never contain `/`, so dot-crossing cannot escape the authority. */
function globToRegExp(glob: string): RegExp {
  let rx = "^";
  for (const ch of glob) {
    if (ch === "*") rx += "[\\s\\S]*";
    else rx += ch.replace(/[.*+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${rx}$`);
}

/**
 * Parse one `scheme://host[:port]` entry. Malformed rules throw at load --
 * a silently dropped deny is worse than a crash.
 */
export function parseOriginRule(entry: unknown): FetchPolicyRule {
  if (typeof entry !== "string" || entry.trim() === "") {
    throw new ConfigError(`fetchPolicy rule must be a non-empty string, got: ${JSON.stringify(entry)}`);
  }
  const raw = entry.trim();
  const sep = raw.indexOf("://");
  if (sep <= 0 || sep === raw.length - 1) {
    throw new ConfigError(
      `fetchPolicy rule must be 'scheme://host[:port]', got: '${raw}' (no path -- origins have no path)`,
    );
  }
  const scheme = raw.slice(0, sep).toLowerCase();
  if (!/^[a-z*][a-z0-9+.\-*]*$/.test(scheme)) {
    throw new ConfigError(`fetchPolicy rule has an invalid scheme: '${raw}'`);
  }
  const authority = raw.slice(sep + 3);
  if (authority.includes("/") || authority.includes("?") || authority.includes("#")) {
    throw new ConfigError(`fetchPolicy rule must be 'scheme://host[:port]', got: '${raw}' (no path -- origins have no path)`);
  }

  // Split the port off the authority, skipping any IPv6 brackets.
  const afterBrackets = authority.lastIndexOf("]") + 1;
  const colon = authority.indexOf(":", afterBrackets);
  let hostPart = authority;
  let port: number | "*" = "*";
  let portOmitted = true;
  if (colon !== -1) {
    hostPart = authority.slice(0, colon);
    const portText = authority.slice(colon + 1);
    portOmitted = false;
    if (portText === "*") port = "*";
    else if (/^\d+$/.test(portText) && Number(portText) >= 0 && Number(portText) <= 65535) {
      port = Number(portText);
    } else {
      throw new ConfigError(`fetchPolicy rule has an invalid port: '${raw}'`);
    }
  }
  if (hostPart.startsWith("[")) {
    if (!hostPart.endsWith("]")) {
      throw new ConfigError(`fetchPolicy rule has an unbalanced IPv6 literal: '${raw}'`);
    }
    hostPart = hostPart.slice(1, -1);
  }
  hostPart = hostPart.toLowerCase().replace(/\.$/, "");
  if (hostPart === "") {
    throw new ConfigError(`fetchPolicy rule has an empty host: '${raw}'`);
  }

  if (portOmitted) {
    if (DEFAULT_PORTS[scheme] !== undefined) port = DEFAULT_PORTS[scheme];
    else if (scheme === "*") port = "*"; // globbed scheme: any port
    else {
      throw new ConfigError(
        `fetchPolicy rule 'scheme ${scheme}' has no default port -- write ':<port>' or ':*' (rule: '${raw}')`,
      );
    }
  }

  // `*.example.com` also matches the bare apex; `?`-leading patterns keep strict glob semantics.
  const apex = hostPart.startsWith("*.") ? hostPart.slice(2) : null;

  return { raw, schemeRe: globToRegExp(scheme), hostRe: globToRegExp(hostPart), apex, port };
}

/** Compile + validate the RESOLVED config block. Throws ConfigError on anything malformed. */
export function compileFetchPolicy(cfg: ResolvedFetchPolicyConfig): FetchPolicyRules {
  if (cfg === undefined || cfg === null) {
    throw new ConfigError("fetchPolicy: resolved config block is required");
  }
  const def = cfg.default;
  if (def !== "ask" && def !== "allow" && def !== "deny") {
    throw new ConfigError(`fetchPolicy.default must be "ask", "allow" or "deny", got: ${JSON.stringify(cfg.default)}`);
  }
  const asRuleList = (value: unknown, key: "allow" | "deny"): FetchPolicyRule[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      throw new ConfigError(`fetchPolicy.${key} must be an array of rule strings`);
    }
    return value.map((e) => parseOriginRule(e));
  };
  return { default: def, allow: asRuleList(cfg.allow, "allow"), deny: asRuleList(cfg.deny, "deny") };
}

/**
 * Reduce a URL (string or URL) to a matchable origin, or null when the text
 * is not a usable URL or the scheme has no port story. Credential userinfo
 * is dropped by URL parsing and never appears in `origin`.
 */
export function originOf(input: string | URL): Origin | null {
  let u: URL;
  try {
    u = typeof input === "string" ? new URL(input) : input;
  } catch {
    return null;
  }
  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  if (!scheme) return null;
  // Bun keeps brackets on IPv6 hostnames; rules and origins match bracketless.
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (host === "") return null;
  const port = u.port === "" ? DEFAULT_PORTS[scheme] : Number(u.port);
  if (port === undefined || !Number.isInteger(port)) return null;
  const hostText = isIP(host) === 6 ? `[${host}]` : host;
  const origin = `${scheme}://${hostText}${port === DEFAULT_PORTS[scheme] ? "" : `:${port}`}`;
  return { scheme, host, port, origin };
}

function ruleMatches(rule: FetchPolicyRule, origin: Origin): boolean {
  if (!rule.schemeRe.test(origin.scheme)) return false;
  if (!rule.hostRe.test(origin.host) && !(rule.apex !== null && rule.apex === origin.host)) return false;
  return rule.port === "*" || rule.port === origin.port;
}

/** deny > allow > default. */
export function decideOrigin(origin: Origin, rules: FetchPolicyRules): OriginDecision {
  const hit = (list: FetchPolicyRule[]) => list.find((r) => ruleMatches(r, origin));

  const denyRule = hit(rules.deny);
  if (denyRule) {
    return {
      verdict: "deny",
      matched: [denyRule.raw],
      reasons: [`origin '${origin.origin}' matches the fetchPolicy deny rule '${denyRule.raw}'`],
    };
  }
  const allowRule = hit(rules.allow);
  if (allowRule) {
    return {
      verdict: "allow",
      matched: [allowRule.raw],
      reasons: [`origin '${origin.origin}' matches the fetchPolicy allow rule '${allowRule.raw}'`],
    };
  }
  return {
    verdict: rules.default,
    matched: [],
    reasons: [`no fetchPolicy rule matches '${origin.origin}' and fetchPolicy.default is "${rules.default}"`],
  };
}
