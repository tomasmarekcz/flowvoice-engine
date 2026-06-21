import { describe, it, expect } from "vitest";
import {
  mulawToLinear,
  linearToMulaw,
  upsample8kTo24k,
  downsample24kTo8k,
  pcm8kToFloat32,
  float32ToPcm8k,
  pcm24kToBase64,
  base64ToPcm24k,
} from "../src/audio";

describe("mulaw encode/decode roundtrip", () => {
  it("roundtrips silence (0)", () => {
    expect(mulawToLinear(linearToMulaw(0))).toBe(0);
  });

  it("roundtrips a positive sample within mulaw precision (5% error)", () => {
    const original = 1000;
    const decoded = mulawToLinear(linearToMulaw(original));
    expect(Math.abs(decoded - original) / original).toBeLessThan(0.05);
  });

  it("roundtrips a negative sample within mulaw precision", () => {
    const original = -1000;
    const decoded = mulawToLinear(linearToMulaw(original));
    expect(Math.abs(decoded - original) / Math.abs(original)).toBeLessThan(0.05);
  });
});

describe("resampling", () => {
  it("upsample 8kHz → 24kHz triples sample count", () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    const output = upsample8kTo24k(input);
    expect(output.length).toBe(9);
    expect(output[0]).toBeCloseTo(0.1, 5);
    expect(output[8]).toBeCloseTo(0.3, 5);
  });

  it("downsample 24kHz → 8kHz takes every 3rd sample", () => {
    const input = new Float32Array([0.1, 0.5, 0.9, 0.2, 0.6, 1.0]);
    const output = downsample24kTo8k(input);
    expect(output.length).toBe(2);
    expect(output[0]).toBeCloseTo(0.1, 5);
    expect(output[1]).toBeCloseTo(0.2, 5);
  });
});

describe("PCM16 24kHz base64 roundtrip", () => {
  it("roundtrips float samples through base64 PCM16", () => {
    const samples = new Float32Array([0.0, 0.5, -0.5, 1.0, -1.0]);
    const decoded = base64ToPcm24k(pcm24kToBase64(samples));
    expect(decoded.length).toBe(samples.length);
    for (let i = 0; i < samples.length; i++) {
      expect(Math.abs(decoded[i] - samples[i])).toBeLessThan(0.001);
    }
  });
});

describe("mulaw base64 roundtrip (Twilio ↔ OpenAI path)", () => {
  it("encodes silence and decodes back to near-zero", () => {
    const silence = new Float32Array(8);
    const decoded = pcm8kToFloat32(float32ToPcm8k(silence));
    for (const s of decoded) expect(Math.abs(s)).toBeLessThan(0.01);
  });
});
