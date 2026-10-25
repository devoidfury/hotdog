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

/**
 * Does this hostname name "this machine"? Covers all of 127.0.0.0/8 (the
 * whole range is loopback; systemd-resolved answers on 127.0.0.53), ::1, and
 * localhost plus every *.localhost subdomain -- browsers resolve .localhost
 * to loopback locally (RFC 6761) and never query DNS for it, so a rebound
 * page cannot hold one of these names. Input must be a normalized host:
 * lowercased, port and IPv6 brackets stripped (hostnameOf and Bun's bind
 * config supply that).
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  );
}

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

  if (isLoopbackHost(bound)) {
    return isLoopbackHost(originHost) && isLoopbackHost(hostName);
  }
  if (WILDCARD_HOSTS.has(bound)) {
    return originHost === hostName;
  }
  return originHost === bound && hostName === bound;
}
