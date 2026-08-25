import pkg from "@package.json" with { type: "json" };

const USER_AGENT = `hotdog/v${pkg.version} NOT Mozilla/5.0 (probably running linux; probably x64) AND NOT AppleWebKit/666.42 (NOT KHTML, unlike Gecko) NOR Chrome/127.0.0.1 ALSO NOT Safari/420.69`;

export const VALID_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"];
export const METHODS_WITH_BODY = ["POST", "PUT", "PATCH"];

/**
 * Combine multiple abort signals into one. Whichever input signal aborts
 * first wins. Uses AbortSignal.any when available (Bun >= 1.1) with a
 * manual fallback for older runtimes.
 *
 * @param signals - Signals to combine.
 * @returns A single signal, or undefined if none were provided.
 */
function combineSignals(signals: AbortSignal[]): AbortSignal | undefined {
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  const anySignal = (
    AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }
  ).any;
  if (typeof anySignal === "function") {
    return anySignal(signals);
  }
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      return controller.signal;
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

/**
 * fetch() wrapper with a user-agent, method validation, and an optional timeout.
 *
 * @param url - The URL to request.
 * @param args - Standard RequestInit. A caller-provided `signal` is honored
 *   and combined with the timeout, so both can abort the request.
 * @param timeoutMs - Optional timeout in milliseconds. Aborts the request
 *   (headers and/or body still pending) with a TimeoutError when it fires.
 */
export async function hotdogFetch(
  url: string,
  args?: RequestInit,
  timeoutMs?: number,
) {
  if (!VALID_METHODS.includes(args?.method ?? "GET")) {
    throw new Error(
      `Invalid HTTP method: '${args?.method}'. Supported: ${VALID_METHODS.join(", ")}`,
    );
  }
  const headers = args?.headers ?? {};
  const signals: AbortSignal[] = [];
  if (args?.signal) signals.push(args.signal);
  if (timeoutMs != null && timeoutMs > 0) {
    signals.push(AbortSignal.timeout(timeoutMs));
  }
  const signal = combineSignals(signals);
  return await fetch(url, {
    ...args,
    body:
      (METHODS_WITH_BODY.includes(args?.method ?? "") && args?.body) || undefined,
    headers: {
      "User-Agent": USER_AGENT,
      ...headers,
    },
    signal,
  });
}

/**
 * Read a response body up to a character cap. Stops reading (and releases
 * the connection) once the cap is exceeded, so huge responses are bounded
 * in memory. Abort/timeout errors from the fetch signal propagate.
 *
 * @param resp - The Response to read.
 * @param maxChars - Maximum characters to accumulate.
 * @returns The (possibly capped) text and whether the body was cut off.
 */
export async function readCappedBody(
  resp: Response,
  maxChars: number,
): Promise<{ text: string; truncated: boolean }> {
  const body = resp.body;
  if (!body) {
    const text = await resp.text();
    return { text: text.slice(0, maxChars), truncated: text.length > maxChars };
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length > maxChars) {
      truncated = true;
      break;
    }
  }
  if (truncated) {
    // Stop pulling from the connection once the cap is hit.
    await reader.cancel().catch(() => {});
  } else {
    text += decoder.decode();
  }
  return { text: text.slice(0, maxChars), truncated };
}
