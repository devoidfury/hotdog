// Tests for webui/ui/wav.ts -- the pure PCM16 wav container writer.
// (audioBlobToWav needs a browser AudioContext and is not exercisable in Bun.)

import { describe, it, expect } from "bun:test";
import { encodeWavPcm16 } from "@extensions/webui/ui/wav.ts";

function readHeader(buffer: ArrayBuffer) {
  const v = new DataView(buffer);
  const ascii = (o: number, n: number) => {
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(v.getUint8(o + i));
    return s;
  };
  return {
    riff: ascii(0, 4),
    riffSize: v.getUint32(4, true),
    wave: ascii(8, 4),
    fmt: ascii(12, 4),
    fmtSize: v.getUint32(16, true),
    audioFormat: v.getUint16(20, true),
    channels: v.getUint16(22, true),
    sampleRate: v.getUint32(24, true),
    byteRate: v.getUint32(28, true),
    blockAlign: v.getUint16(32, true),
    bitsPerSample: v.getUint16(34, true),
    data: ascii(36, 4),
    dataSize: v.getUint32(40, true),
    samples: Array.from({ length: (buffer.byteLength - 44) / 2 }, (_, i) =>
      v.getInt16(44 + i * 2, true),
    ),
  };
}

describe("encodeWavPcm16", () => {
  it("writes a valid 16k mono header", () => {
    const wav = encodeWavPcm16([new Float32Array([0, 0.5, -0.5])], 16000);
    const h = readHeader(wav);
    expect(h.riff).toBe("RIFF");
    expect(h.riffSize).toBe(wav.byteLength - 8);
    expect(h.wave).toBe("WAVE");
    expect(h.fmt).toBe("fmt ");
    expect(h.fmtSize).toBe(16);
    expect(h.audioFormat).toBe(1); // PCM
    expect(h.channels).toBe(1);
    expect(h.sampleRate).toBe(16000);
    expect(h.byteRate).toBe(32000);
    expect(h.blockAlign).toBe(2);
    expect(h.bitsPerSample).toBe(16);
    expect(h.data).toBe("data");
    expect(h.dataSize).toBe(6);
    expect(wav.byteLength).toBe(44 + 6);
  });

  it("encodes samples to int16 with end-skewed full scale", () => {
    const wav = encodeWavPcm16([new Float32Array([0, 1, -1, 0.5])], 16000);
    expect(readHeader(wav).samples).toEqual([0, 32767, -32768, 16383]); // setInt16 truncates
  });

  it("clips out-of-range samples", () => {
    const wav = encodeWavPcm16([new Float32Array([2, -2])], 16000);
    expect(readHeader(wav).samples).toEqual([32767, -32768]);
  });

  it("interleaves multiple channels", () => {
    const wav = encodeWavPcm16(
      [new Float32Array([1, 0]), new Float32Array([0, -1])],
      44100,
    );
    const h = readHeader(wav);
    expect(h.channels).toBe(2);
    expect(h.sampleRate).toBe(44100);
    expect(h.samples).toEqual([32767, 0, 0, -32768]);
  });

  it("zero-pads shorter channels and handles empty input", () => {
    const wav = encodeWavPcm16([new Float32Array([1]), new Float32Array()], 8000);
    const h = readHeader(wav);
    expect(h.samples).toEqual([32767, 0]);
    const empty = encodeWavPcm16([], 16000);
    expect(readHeader(empty).dataSize).toBe(0);
    expect(empty.byteLength).toBe(44);
  });
});
