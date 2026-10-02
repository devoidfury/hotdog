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

/**
 * Byte twin of readCappedBody(): binary-safe (no utf-8 decoding), returns null once the stream
 * is over the cap so callers can reject instead of buffering (a truncated image is garbage anyway).
 */
export async function readCappedBytes(
  resp: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array | null }> {
  const body = resp.body;
  if (!body) {
    const buf = new Uint8Array(await resp.arrayBuffer());
    return { bytes: buf.length > maxBytes ? null : buf };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { bytes: null };
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes: out };
}
