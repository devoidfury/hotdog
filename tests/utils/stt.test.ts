// Tests for the STT client (src/utils/stt.ts) against a fake
// OpenAI-compatible /v1/audio/transcriptions endpoint spun up with Bun.serve.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { transcribeAudio } from "@utils/stt.ts";

interface CapturedRequest {
  contentType: string;
  authHeader: string | null;
  fields: Record<string, string>;
  fileName: string;
  fileType: string;
  fileBytes: number;
  fileText: string;
}

let mode: "ok" | "error" | "notjson" | "notext" = "ok";
let lastRequest: CapturedRequest | null = null;

const fakeStt = Bun.serve({
  port: 0,
  async fetch(req) {
    const contentType = req.headers.get("content-type") ?? "";
    const form = await req.formData();
    const fields: Record<string, string> = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") fields[key] = value;
    }
    const file = form.get("file");
    lastRequest = {
      contentType,
      authHeader: req.headers.get("authorization"),
      fields,
      fileName: file instanceof File ? file.name : "",
      fileType: file instanceof File ? file.type : "",
      fileBytes: file instanceof File ? file.size : 0,
      fileText: file instanceof File ? await file.text() : "",
    };

    if (mode === "error") {
      return Response.json(
        { error: { message: "backend exploded" } },
        { status: 500 },
      );
    }
    if (mode === "notjson") return new Response("<html>not json</html>");
    if (mode === "notext") return Response.json({ result: "wrong shape" });
    return Response.json({ text: "hello transcription" });
  },
});

const endpoint = () => `http://localhost:${fakeStt.port}/v1/audio/transcriptions`;

beforeAll(() => {
  expect(fakeStt.port).toBeGreaterThan(0);
});

afterAll(() => {
  fakeStt.stop(true);
});

beforeEach(() => {
  mode = "ok";
  lastRequest = null;
});

describe("transcribeAudio", () => {
  it("POSTs multipart form-data with file + model fields and returns the parsed text", async () => {
    const audio = new TextEncoder().encode("FAKEAUDIOBYTES");
    const text = await transcribeAudio({
      url: endpoint(),
      model: "whisper-1",
      audio,
      mimeType: "audio/webm",
    });

    expect(text).toBe("hello transcription");
    expect(lastRequest).not.toBeNull();
    expect(lastRequest!.contentType.startsWith("multipart/form-data")).toBe(true);
    expect(lastRequest!.fields).toEqual({ model: "whisper-1" });
    expect(lastRequest!.fileName).toBe("audio.webm");
    // NB: Bun's Blob re-sniffs the container from the .webm extension
    // (video/webm); the filename extension is what whisper-style servers use.
    expect(lastRequest!.fileBytes).toBe(audio.byteLength);
    expect(lastRequest!.fileText).toBe("FAKEAUDIOBYTES");
  });

  it("honors an explicit filename and omits the model field when not set", async () => {
    await transcribeAudio({
      url: endpoint(),
      audio: new TextEncoder().encode("x"),
      filename: "dictation.ogg",
      mimeType: "audio/ogg",
    });

    expect(lastRequest!.fileName).toBe("dictation.ogg");
    expect(lastRequest!.fields).toEqual({});
  });

  it("falls back to a .bin filename for unknown mime types", async () => {
    await transcribeAudio({
      url: endpoint(),
      audio: new TextEncoder().encode("x"),
      mimeType: "audio/vnd.weird",
    });
    expect(lastRequest!.fileName).toBe("audio.bin");
  });

  it("throws a readable error on non-ok responses (status + body snippet)", async () => {
    mode = "error";
    let caught: Error | null = null;
    try {
      await transcribeAudio({
        url: endpoint(),
        model: "m",
        audio: new TextEncoder().encode("x"),
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("STT request failed");
    expect(caught!.message).toContain("500");
    expect(caught!.message).toContain("backend exploded");
  });

  it("throws when the response body is not JSON", async () => {
    mode = "notjson";
    expect(
      transcribeAudio({ url: endpoint(), audio: new TextEncoder().encode("x") }),
    ).rejects.toThrow("not valid JSON");
  });

  it("throws when the JSON response has no string text field", async () => {
    mode = "notext";
    expect(
      transcribeAudio({ url: endpoint(), audio: new TextEncoder().encode("x") }),
    ).rejects.toThrow('missing string "text"');
  });

  it("converts URL userinfo into a Basic Authorization header", async () => {
    const url = endpoint().replace("://", `://:${"secr3t-key"}@`);
    const text = await transcribeAudio({
      url,
      audio: new TextEncoder().encode("x"),
    });
    expect(text).toBe("hello transcription");
    expect(lastRequest!.authHeader).toBe(
      `Basic ${Buffer.from(":secr3t-key").toString("base64")}`,
    );
  });

  it("sends no Authorization header for a bare URL", async () => {
    await transcribeAudio({ url: endpoint(), audio: new TextEncoder().encode("x") });
    expect(lastRequest!.authHeader).toBeNull();
  });

  it("passes through an unparseable URL when splitUrlAuth can't parse it", async () => {
    // An invalid URL falls through splitUrlAuth's catch block and the raw
    // string is handed to fetch, which throws. We only care that the
    // splitUrlAuth path is exercised (line 56).
    let caught: Error | null = null;
    try {
      await transcribeAudio({ url: "not-a-valid-url", audio: new TextEncoder().encode("x") });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("invalid");
  });
});
