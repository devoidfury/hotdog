// Tests for the hotdogFetch wrapper -- method validation, optional
// timeout, and composition of caller-provided abort signals.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { hotdogFetch, readCappedBody, VALID_METHODS, METHODS_WITH_BODY } from "../../src/utils/fetch.ts";

const TEST_PORT = 18933;
const BASE_URL = `http://localhost:${TEST_PORT}`;

let server: ReturnType<typeof Bun.serve> | null = null;

beforeAll(() => {
  server = Bun.serve({
    port: TEST_PORT,
    fetch(req) {
      const url = new URL(req.url);
      // /slow — responds after a 3s delay (timeout tests)
      if (url.pathname === "/slow") {
        return new Promise<Response>((resolve) =>
          setTimeout(() => resolve(new Response("slow")), 3000),
        );
      }
      // /headers — echoes the received request headers
      if (url.pathname === "/headers") {
        const h: Record<string, string> = {};
        req.headers.forEach((v, k) => (h[k] = v));
        return new Response(JSON.stringify(h), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("ok", { headers: { "Content-Type": "text/plain" } });
    },
  });
});

afterAll(() => {
  server?.stop(true);
  server = null;
});

describe("hotdogFetch", () => {
  it("performs a plain GET without signals", async () => {
    const resp = await hotdogFetch(`${BASE_URL}/`);
    expect(resp.ok).toBe(true);
    expect(await resp.text()).toBe("ok");
  });

  it("throws on unsupported HTTP methods", async () => {
    await expect(
      hotdogFetch(`${BASE_URL}/`, { method: "OPTIONS" }),
    ).rejects.toThrow(/Invalid HTTP method/);
  });

  it("exposes the method allow-lists", () => {
    expect(VALID_METHODS).toEqual(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"]);
    expect(METHODS_WITH_BODY).toEqual(["POST", "PUT", "PATCH"]);
  });

  it("aborts when the caller's signal fires (no timeout given)", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const t0 = Date.now();
    await expect(
      hotdogFetch(`${BASE_URL}/slow`, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("aborts with TimeoutError when only a timeout is given", async () => {
    const t0 = Date.now();
    await expect(
      hotdogFetch(`${BASE_URL}/slow`, undefined, 300),
    ).rejects.toThrow();
    // Must fire near the timeout, not at the server's 3s delay.
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("honors a caller signal that aborts before the timeout", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const t0 = Date.now();
    // Caller aborts at ~100ms, well before the 3s timeout.
    await expect(
      hotdogFetch(`${BASE_URL}/slow`, { signal: controller.signal }, 3000),
    ).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("still times out when the caller signal never fires", async () => {
    const controller = new AbortController(); // never aborted
    const t0 = Date.now();
    await expect(
      hotdogFetch(`${BASE_URL}/slow`, { signal: controller.signal }, 300),
    ).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("does not inject a default Content-Type when the caller sets none", async () => {
    const resp = await hotdogFetch(`${BASE_URL}/headers`);
    const headers = (await resp.json()) as Record<string, string>;
    expect(headers["content-type"]).toBeUndefined();
  });

  it("sends the caller's Content-Type untouched", async () => {
    const resp = await hotdogFetch(`${BASE_URL}/headers`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "hi",
    });
    const headers = (await resp.json()) as Record<string, string>;
    expect(headers["content-type"]).toBe("text/plain");
  });

  it("ignores non-positive timeouts", async () => {
    // A 0/negative timeout must not abort a fast request.
    const resp = await hotdogFetch(`${BASE_URL}/`, undefined, 0);
    expect(await resp.text()).toBe("ok");
  });

  it("combines caller signal + timeout; caller abort wins", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const t0 = Date.now();
    await expect(
      hotdogFetch(`${BASE_URL}/slow`, { signal: controller.signal }, 3000),
    ).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("aborts immediately when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      hotdogFetch(`${BASE_URL}/`, { signal: controller.signal }, 3000),
    ).rejects.toThrow();
  });
});

describe("readCappedBody", () => {
  it("returns the full body when under the cap", async () => {
    const resp = new Response("hello world");
    const { text, truncated } = await readCappedBody(resp, 100);
    expect(text).toBe("hello world");
    expect(truncated).toBe(false);
  });

  it("caps at maxChars and flags truncation", async () => {
    const resp = new Response("x".repeat(10_000));
    const { text, truncated } = await readCappedBody(resp, 100);
    expect(text.length).toBe(100);
    expect(truncated).toBe(true);
  });

  it("handles empty bodies", async () => {
    const resp = new Response("");
    const { text, truncated } = await readCappedBody(resp, 100);
    expect(text).toBe("");
    expect(truncated).toBe(false);
  });

  it("falls back to resp.text() when no body stream is present", async () => {
    const resp = { text: async () => "abcdef" } as unknown as Response;
    const { text, truncated } = await readCappedBody(resp, 3);
    expect(text).toBe("abc");
    expect(truncated).toBe(true);
  });
});
