// WHATWG HTML "Interpreting an event stream" (9.2.6) conformance for
// src/utils/sse-parser.ts. Oracle: whatwg-9.2.6-normative.txt + streams
// mechanically derived from its rules (derived-streams.json).
//
// hotdog is an OpenAI-flavored JSON SSE parser, not a browser EventSource;
// see README.md "Deviations" for the three places where it intentionally
// differs from the browser dispatch algorithm.

import { describe, it, expect } from "bun:test";
import { parseSse } from "@utils/sse-parser.ts";
import { loadJsonFixture, streamFromText } from "./helpers.ts";

interface Case {
  name: string;
  cite: string;
  stream: string;
  expect: Record<string, unknown>[];
  deviation?: boolean;
}

const { data } = await loadJsonFixture<{ cases: Case[] }>("sse/derived-streams.json");

async function collect(text: string, chunkBytes = 0): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const e of parseSse(streamFromText(text, chunkBytes))) events.push(e);
  return events;
}

describe("SSE conformance (WHATWG HTML 9.2.6)", () => {
  for (const c of data.cases) {
    it(`WHATWG 9.2.6 (${c.name}): ${c.cite}`, async () => {
      expect(await collect(c.stream)).toEqual(c.expect);
    });
  }

  it("WHATWG 9.2.6 (byte-boundary property): a stream split at any chunk size yields identical events", async () => {
    for (const c of data.cases) {
      const whole = await collect(c.stream);
      for (let size = 1; size <= 3; size++) {
        expect(await collect(c.stream, size)).toEqual(whole);
      }
    }
  });
});
