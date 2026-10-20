// The upgraded-socket type shared across the websocket modules, split out of
// server.ts so siblings (and websocket-channel.ts) can name it without
// importing the wiring. The socket <-> websocket-channel type pair is
// import-type-only on both sides (erased at runtime).

import type { WebSocketChannel } from "./websocket-channel.ts";

export type HotdogServerSocket<T = undefined> = Bun.ServerWebSocket<T> & {
  activeSessionId?: string;
  activeChannel?: WebSocketChannel;
  authToken?: string;
  /** Reconnect identity from the upgrade URL (?session=...&cursor=...): the
   *  session the client was on, plus its replay position (full log length at
   *  the last attach -- an append-only coordinate, stable across RESETs). */
  resumeSessionId?: string;
  resumeCursor?: number;
  /** True once an implicit attach has been started for this socket. The
   *  post-AUTH attach site must not fire its own while the upgrade-site
   *  attach is in flight: activeSessionId is only set once the attach's
   *  first awaits settle, so it cannot gate the race (a token-upgrade client
   *  that also sends AUTH would otherwise get two attach bursts). Never
   *  cleared: a socket takes at most one implicit attach; later switches
   *  are explicit (SWITCH_SESSION). */
  attachStarted?: boolean;
};

