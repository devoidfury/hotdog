// WebSocket upgrade-origin validation.
//
// Browsers always send `Origin` on a WebSocket handshake, and this socket opens
// unauthenticated by design (auth rides the first protocol message), so
// same-origin-ness is the one thing the server can check BEFORE the upgrade,
// while a rejection can still be a plain 403 with no session state created.
// Without it, any web page a logged-in user visits -- or any domain that
// DNS-rebinds to the bound address -- can open a socket into a live agent.
//
// Fail closed: a missing, unparseable, or foreign Origin is refused. Honest
// browsers always send it; this host has no legitimate non-browser WS clients
// to accommodate.

/** Hostnames that name "this machine" for a loopback-bound server. */
export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** Addresses that bind every interface (no enumerable own-name set). */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::"]);

/** Lowercased hostname of an URL or authority; strips port and IPv6 brackets. */
function hostnameOf(input: string): string | null {
  try {
    const url = new URL(input.includes("://") ? input : `http://${input}`);
    return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

/**
 * May this upgrade request proceed?
 *
 * - loopback bind: BOTH Host and Origin must name a loopback host. Comparing
 *   Origin against Host alone would not do: a DNS-rebound page sends the
 *   attacker domain in both headers even though the TCP peer is the local machine.
 * - named-host bind: both must name that host.
 * - wildcard bind (0.0.0.0 / ::): the server owns no enumerable name set, so
 *   fall back to same-origin (Origin host == Host host). That still stops
 *   cross-site browser upgrades; telling a rebound domain from the real one
 *   needs TLS + a name policy, which is the reverse-proxy's job.
 */
export function upgradeOriginAllowed(
  origin: string | null,
  host: string | null,
  boundHost: string,
): boolean {
  if (!origin || !host) return false;
  const originHost = hostnameOf(origin);
  const hostName = hostnameOf(host);
  const bound = hostnameOf(boundHost) ?? boundHost.toLowerCase();
  if (!originHost || !hostName) return false;

  if (LOOPBACK_HOSTS.has(bound)) {
    return LOOPBACK_HOSTS.has(originHost) && LOOPBACK_HOSTS.has(hostName);
  }
  if (WILDCARD_HOSTS.has(bound)) {
    return originHost === hostName;
  }
  return originHost === bound && hostName === bound;
}
