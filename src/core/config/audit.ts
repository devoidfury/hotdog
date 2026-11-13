/**
 * audit.ts -- the config-live audit-notice primitive.
 *
 * ONE shared seam for every config-live trust-change notice, owning two
 * surfaces:
 *
 *  1. THE LOG: `logger.warn("[config-live] <keyPath>: <summary>")` -- the
 *     grep-able shape every config-live hook emits (the hooks' lines were
 *     exactly `[config-live] ` + their text before this seam existed;
 *     routing them through `configAuditNotice` keeps those bytes identical,
 *     which the existing prefix pins rely on).
 *  2. THE SURFACE: a webui push so live sessions SEE the operator's change
 *     (the exec-fence precedent, handlers-exec-fence.ts + fence-command.ts:
 *     a transcript addMessage so the record lands on the session log, plus
 *     the registry.broadcastScoped transport push so connected panels
 *     repaint). Core cannot import the websocket extension, so the sink is
 *     a registered seam: the webui server registers it at serve time and
 *     UNREGISTERS at stop; a host that never served webui has no sink and
 *     the log line alone is the (complete) audit floor.
 *
 * Summaries are HOOK-AUTHORED old->new redacted descriptions, never raw
 * dumps: callers pass human text and never hand secret values to this seam
 * (trust-class doctrine -- hosts only for endpoints, set/unset/changed for
 * credentials, zero value bytes).
 *
 * Failure floor (the same one the fence toggle documents): a notice that
 * cannot be delivered must log LOUDLY -- an unlogged trust change must never
 * pass silently. The log line is written FIRST, so a throwing surface sink
 * can never suppress it; the delivery failure itself is an error log.
 */
import { formatError } from "@core/error.ts";
import { logger } from "@utils/logger.ts";

/** One surface notice for one config change. `text` is the full
 *  "<keyPath>: <summary>" body (the same string the log line carries).
 *  The sink fans it out to the sessions that should see it; throwing is
 *  the caller's problem, handled below. */
export type ConfigAuditSurface = (text: string) => void;

let surface: ConfigAuditSurface | null = null;

/** Register the webui surface sink (serve time). Returns the unregister
 *  closure; it restores whatever sink was registered before, so two servers
 *  in one process (tests) nest cleanly and a stop never leaves a dead
 *  server's registry behind as the surface. */
export function registerConfigAuditSurface(sink: ConfigAuditSurface): () => void {
  const previous = surface;
  surface = sink;
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (surface === sink) surface = previous;
  };
}

/** Emit one audit notice: `text` is "<keyPath>: <summary>" (hook-authored,
 *  secret-free by construction). Log first, surface second; a surface
 *  failure is itself logged loudly (never silent). */
export function configAuditNotice(text: string): void {
  logger.warn(`[config-live] ${text}`);
  if (!surface) return; // host without a served webui: the log line is the floor
  try {
    surface(text);
  } catch (e) {
    logger.error(
      `[config-live] surface notice delivery FAILED (${text}): ${formatError(e)} -- the change was logged above but live sessions were NOT notified`,
    );
  }
}
