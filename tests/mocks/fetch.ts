// fetch mocking for tests that stub globalThis.fetch.
// Replaces the per-test try/finally save-swap-restore boilerplate:
//
//   await withMockFetch(async (url, opts) => mockResponse(), async () => {
//     const result = await tool.execute(...);
//     expect(result).toBe("...");
//   });

import { mock } from "bun:test";

type FetchImpl = (url: string, opts?: RequestInit) => Response | Promise<Response>;

/** Run `fn` with globalThis.fetch replaced by a mock wrapping `impl`. */
export async function withMockFetch<T>(impl: FetchImpl, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = mock(impl) as unknown as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/** Build a minimal Response whose body is the given text (JSON by default). */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Build a minimal Response with a raw text body. */
export function textResponse(body: string, status = 200, contentType = "text/plain"): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}
