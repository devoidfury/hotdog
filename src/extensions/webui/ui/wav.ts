// Browser-side WAV re-encoding for push-to-talk.
//
// MediaRecorder emits webm/opus (Chrome/Firefox) or mp4 (Safari), but
// llama.cpp-style transcription backends reject both with
// "Failed to load image or audio file" -- wav, mp3 and flac are the formats
// they reliably decode. Rather than depend on a backend ffmpeg, the browser
// decodes its own recording (decodeAudioData), resamples to 16 kHz mono via
// OfflineAudioContext (which also downmixes channels), and repacks as PCM16
// wav -- a format every STT endpoint accepts.

const STT_SAMPLE_RATE = 16000;

/** Wrap interleaved PCM float [-1,1] channel data in a 16-bit wav container. */
export function encodeWavPcm16(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const frames = channels.reduce((max, ch) => Math.max(max, ch.length), 0);
  const numChannels = Math.max(1, channels.length);
  const buffer = new ArrayBuffer(44 + frames * numChannels * 2);
  const v = new DataView(buffer);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + frames * numChannels * 2, true);
  ascii(8, "WAVEfmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, numChannels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * numChannels * 2, true); // byte rate
  v.setUint16(32, numChannels * 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  v.setUint32(40, frames * numChannels * 2, true);
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const x = channels[c]?.[i] ?? 0;
      // Clip to [-1, 1] and skew each end to its full int16 range.
      const clamped = x < -1 ? -1 : x > 1 ? 1 : x;
      v.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
  }
  return buffer;
}

/** Decode a recorded audio blob and re-encode it as 16 kHz mono wav. */
export async function audioBlobToWav(blob: Blob): Promise<Blob> {
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const frames = Math.max(1, Math.ceil(decoded.duration * STT_SAMPLE_RATE));
    // A 1-channel OfflineAudioContext downmixes multi-channel sources for us.
    const off = new OfflineAudioContext(1, frames, STT_SAMPLE_RATE);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    return new Blob([encodeWavPcm16([rendered.getChannelData(0)], STT_SAMPLE_RATE)], {
      type: "audio/wav",
    });
  } finally {
    void ctx.close().catch(() => {});
  }
}
