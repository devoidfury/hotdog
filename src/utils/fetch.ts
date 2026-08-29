import pkg from "@package.json" with { type: "json" };

const USER_AGENT = `hotdog/v${pkg.version} NOT Mozilla/5.0 (probably running linux; probably x64) AND NOT AppleWebKit/666.42 (NOT KHTML, unlike Gecko) NOR Chrome/127.0.0.1 ALSO NOT Safari/420.69`;

export const VALID_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"];
export const METHODS_WITH_BODY = ["POST", "PUT", "PATCH"];

function combineSignals(signals: AbortSignal[]): AbortSignal | undefined {
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

/**
 * fetch() wrapper: sets the user agent, validates the method, and optionally
 * times out. A caller-provided signal is combined with the timeout so either
 * can abort the request.
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

/** Read a response body up to maxChars; stops reading (releasing the connection) once over. */
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
    await reader.cancel().catch(() => {});
  } else {
    text += decoder.decode();
  }
  return { text: text.slice(0, maxChars), truncated };
}
