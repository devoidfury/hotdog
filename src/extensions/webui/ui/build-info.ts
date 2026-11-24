// The web client's build stamp and the honest version-skew decision.
//
// The stamp is the package version, inlined by Bun when it bundles the UI
// (the daemon serves the bundle, so a bundle and a daemon of one checkout
// always agree). The daemon reports its own version additively on the AUTH
// handshake; the app's banner compares the two. A daemon that reports
// NOTHING is older than the banner feature itself -- exactly the build the
// banner tells you to restart -- so a missing report is skew, not peace.

import pkg from "@package.json" with { type: "json" };

/** The version this bundle was built from. */
export const CLIENT_VERSION: string = pkg.version;

/** True when the connected daemon's reported version does not match this
 *  bundle's stamp (including a missing report). Equal versions never skew. */
export function versionSkews(daemonVersion: string | null | undefined): boolean {
  return daemonVersion !== CLIENT_VERSION;
}
