// Tests for STT target resolution (src/core/config/stt.ts): explicit sttUrl
// wins; otherwise an audio-capable registry model is picked (pinned by
// sttModel or auto-scanned), with provider URL + key from the LlmClient.

import { describe, it, expect } from "bun:test";
import { resolveSttTarget, type SttProviderResolver } from "@core/config/stt.ts";

const client = (url: string, apiKey: string | null): SttProviderResolver => ({
  resolveProviderSettings: () => ({ url, apiKey }),
});

const AUDIO_ENTRY = { name: "qwen3-asr", inputModalities: ["audio"], outputModalities: ["text"] };
const TEXT_ENTRY = { name: "chat-model", inputModalities: ["text"], outputModalities: ["text"] };

describe("resolveSttTarget", () => {
  it("prefers an explicit sttUrl and passes sttModel through, unauthenticated", () => {
    const target = resolveSttTarget(
      { sttUrl: "http://other:1234/v1/audio/transcriptions", sttModel: "whisper-1", modelRegistry: { m: AUDIO_ENTRY } },
      client("http://prov", "KEY"),
    );
    expect(target).toEqual({ url: "http://other:1234/v1/audio/transcriptions", model: "whisper-1", authHeader: null });
  });

  it("auto-selects the first registry model declaring audio in / text out", () => {
    const target = resolveSttTarget(
      { modelRegistry: { "prov/chat": TEXT_ENTRY, "prov/asr": AUDIO_ENTRY } },
      client("http://prov", "KEY"),
    );
    expect(target).toEqual({
      url: "http://prov/v1/audio/transcriptions",
      model: "qwen3-asr",
      authHeader: "Bearer KEY",
    });
  });

  it("trims a trailing slash on the provider url", () => {
    const target = resolveSttTarget({ modelRegistry: { a: AUDIO_ENTRY } }, client("http://prov/", "KEY"));
    expect(target!.url).toBe("http://prov/v1/audio/transcriptions");
  });

  it("never auto-picks entries with absent modality data", () => {
    expect(resolveSttTarget({ modelRegistry: { mystery: { name: "m" } } }, client("http://prov", null))).toBeNull();
  });

  it("pins sttModel to a registry entry (bare name matching the provider-prefixed key)", () => {
    const target = resolveSttTarget(
      { sttModel: "qwen3-asr", modelRegistry: { "prov/qwen3-asr": AUDIO_ENTRY } },
      client("http://prov", null),
    );
    expect(target).toEqual({
      url: "http://prov/v1/audio/transcriptions",
      model: "qwen3-asr",
      authHeader: null,
    });
  });

  it("refuses a pinned model that does not declare audio input", () => {
    expect(resolveSttTarget({ sttModel: "chat-model", modelRegistry: { "prov/asr": AUDIO_ENTRY, "prov/chat": TEXT_ENTRY } }, client("http://prov", null))).toBeNull();
  });

  it("returns null for an unknown pin", () => {
    expect(resolveSttTarget({ sttModel: "nope", modelRegistry: { "prov/asr": AUDIO_ENTRY } }, client("http://prov", null))).toBeNull();
  });

  it("returns null without a registry or without any audio-capable entry", () => {
    expect(resolveSttTarget({}, client("http://prov", null))).toBeNull();
    expect(resolveSttTarget({ modelRegistry: { "prov/chat": TEXT_ENTRY } }, client("http://prov", null))).toBeNull();
  });

  it("provider resolution failure disables instead of throwing", () => {
    const boom: SttProviderResolver = {
      resolveProviderSettings: () => {
        throw new Error("No AI URL configured");
      },
    };
    expect(resolveSttTarget({ modelRegistry: { a: AUDIO_ENTRY } }, boom)).toBeNull();
  });

  it("null settings resolve to null", () => {
    expect(resolveSttTarget(null, client("http://prov", null))).toBeNull();
  });
});
