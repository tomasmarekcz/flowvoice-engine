import { describe, it, expect } from "vitest";
import {
  mulawToLinear, linearToMulaw, Upsampler, Downsampler, TelephonyConverter,
  pcm8kToFloat32, float32ToPcm8k, pcm24kToBase64, base64ToPcm24k, isSilentMulaw, mulawLevelDbfs,
} from "../src/audio";

function sine(freq: number, rate: number, seconds: number, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}
const rms = (a: Float32Array, from = 0) => {
  let e = 0; for (let i = from; i < a.length; i++) e += a[i] * a[i];
  return Math.sqrt(e / (a.length - from));
};
function inChunks(input: Float32Array, size: number, process: (c: Float32Array) => Float32Array): Float32Array {
  const parts: Float32Array[] = [];
  for (let i = 0; i < input.length; i += size) parts.push(process(input.subarray(i, i + size)));
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

describe("mulaw encode/decode roundtrip", () => {
  it("roundtrips silence (0)", () => {
    expect(mulawToLinear(linearToMulaw(0))).toBe(0);
  });

  it("roundtrips a positive sample within mulaw precision (5% error)", () => {
    const decoded = mulawToLinear(linearToMulaw(1000));
    expect(Math.abs(decoded - 1000) / 1000).toBeLessThan(0.05);
  });

  it("roundtrips a negative sample within mulaw precision", () => {
    const decoded = mulawToLinear(linearToMulaw(-1000));
    expect(Math.abs(decoded + 1000) / 1000).toBeLessThan(0.05);
  });
});

describe("resampling", () => {
  it("turns n samples at 8 kHz into 3n at 24 kHz and back", () => {
    expect(new Upsampler().process(new Float32Array(160)).length).toBe(480);
    expect(new Downsampler().process(new Float32Array(480)).length).toBe(160);
  });

  it("keeps a voice-band tone at the same loudness going up", () => {
    const out = new Upsampler().process(sine(1000, 8000, 0.5));
    expect(rms(out, 600)).toBeCloseTo(rms(sine(1000, 24000, 0.5), 600), 1);
  });

  it("keeps a voice-band tone at the same loudness going down", () => {
    const out = new Downsampler().process(sine(1000, 24000, 0.5));
    expect(rms(out, 200)).toBeCloseTo(rms(sine(1000, 8000, 0.5), 200), 1);
  });

  it("removes what the 8 kHz line cannot carry instead of folding it into the voice (no aliasing)", () => {
    // 5 kHz is above the 4 kHz limit. Dropping samples without a filter would fold it down to 3 kHz at full loudness.
    const out = new Downsampler().process(sine(5000, 24000, 0.5));
    expect(rms(out, 200)).toBeLessThan(0.02);
  });

  it("gives the same samples whether the audio arrives in one piece or in 20 ms chunks", () => {
    const input = sine(700, 24000, 0.4);
    const whole = new Downsampler().process(input);
    const chunked = inChunks(input, 480, (c) => chunkedDown.process(c));
    expect(chunked.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) expect(chunked[i]).toBeCloseTo(whole[i], 5);
  });

  it("joins upsampled chunks without a click at the boundary", () => {
    const input = sine(700, 8000, 0.4);
    const whole = new Upsampler().process(input);
    const chunked = inChunks(input, 160, (c) => chunkedUp.process(c));
    expect(chunked.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) expect(chunked[i]).toBeCloseTo(whole[i], 5);
  });

  it("keeps a tone intact through a whole phone-to-OpenAI-and-back trip in 20 ms chunks", () => {
    const converter = new TelephonyConverter();
    const frame = (i: number) => float32ToPcm8k(sine(1000, 8000, 0.02).map((_, k) => 0.4 * Math.sin((2 * Math.PI * 1000 * (i * 160 + k)) / 8000)));
    const back: number[] = [];
    for (let i = 0; i < 40; i++) {
      const up = converter.toOpenAI(frame(i));
      const phone = pcm8kToFloat32(converter.toPhone(up));
      back.push(...phone);
    }
    expect(rms(Float32Array.from(back.slice(1600)))).toBeGreaterThan(0.25);
  });
});

// Separate instances so the chunked test keeps one filter state for the whole signal.
const chunkedDown = new Downsampler();
const chunkedUp = new Upsampler();

describe("sample format helpers", () => {
  it("roundtrips PCM16 24 kHz through base64", () => {
    const input = new Float32Array([0, 0.5, -0.5, 0.25]);
    const out = base64ToPcm24k(pcm24kToBase64(input));
    for (let i = 0; i < input.length; i++) expect(out[i]).toBeCloseTo(input[i], 3);
  });
});

describe("looking at mu-law frames", () => {
  it("recognises digital silence (0xFF and 0x7F) but not speech", () => {
    expect(isSilentMulaw(Buffer.alloc(160, 0xff).toString("base64"))).toBe(true);
    expect(isSilentMulaw(Buffer.alloc(160, 0x7f).toString("base64"))).toBe(true);
    const speech = Buffer.alloc(160, 0xff); speech[40] = 0x90;
    expect(isSilentMulaw(speech.toString("base64"))).toBe(false);
    expect(isSilentMulaw("")).toBe(true);
  });

  it("measures loudness in dB below full scale", () => {
    const loud = float32ToPcm8k(sine(1000, 8000, 0.02, 0.5));
    const quiet = float32ToPcm8k(sine(1000, 8000, 0.02, 0.05));
    expect(mulawLevelDbfs(loud)).toBeCloseTo(-9, 0);
    expect(mulawLevelDbfs(quiet)).toBeCloseTo(-29, 0);
    expect(mulawLevelDbfs(Buffer.alloc(160, 0xff).toString("base64"))).toBe(-Infinity);
  });
});
