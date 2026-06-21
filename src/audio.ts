// Decode single μ-law byte → 16-bit signed integer
export function mulawToLinear(u: number): number {
  u = ~u & 0xFF;
  const sign = u & 0x80;
  const exp = (u >> 4) & 0x07;
  const mantissa = u & 0x0F;
  let sample = ((mantissa << 3) + 0x84) << exp;
  sample -= 0x84;
  return sign ? sample : -sample;
}

// Encode 16-bit signed integer → μ-law byte
export function linearToMulaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  const sign = sample < 0 ? 0 : 0x80;
  if (sample < 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exp = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exp > 0; exp--, mask >>= 1) {}
  const mantissa = (sample >> (exp + 3)) & 0x0F;
  return (~(sign | (exp << 4) | mantissa)) & 0xFF;
}

// Linear interpolation upsample: 8kHz → 24kHz (3× factor)
export function upsample8kTo24k(samples: Float32Array): Float32Array {
  const out = new Float32Array(samples.length * 3);
  for (let i = 0; i < samples.length; i++) {
    const current = samples[i];
    const next = samples[i + 1] ?? current;
    out[i * 3] = current;
    out[i * 3 + 1] = current + (next - current) / 3;
    out[i * 3 + 2] = current + (2 * (next - current)) / 3;
  }
  return out;
}

// Downsample: 24kHz → 8kHz (take every 3rd sample)
export function downsample24kTo8k(samples: Float32Array): Float32Array {
  const out = new Float32Array(Math.floor(samples.length / 3));
  for (let i = 0; i < out.length; i++) out[i] = samples[i * 3];
  return out;
}

// Base64 μ-law 8kHz → float samples
export function pcm8kToFloat32(mulawB64: string): Float32Array {
  const buf = Buffer.from(mulawB64, "base64");
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = mulawToLinear(buf[i]) / 32768;
  return out;
}

// Float samples → base64 μ-law 8kHz
export function float32ToPcm8k(samples: Float32Array): string {
  const bytes = Buffer.alloc(samples.length);
  for (let i = 0; i < samples.length; i++) {
    bytes[i] = linearToMulaw(Math.max(-32768, Math.min(32767, samples[i] * 32768)));
  }
  return bytes.toString("base64");
}

// Float samples → base64 PCM16 24kHz (OpenAI/browser format)
export function pcm24kToBase64(samples: Float32Array): string {
  const int16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    int16[i] = Math.max(-32768, Math.min(32767, samples[i] * 32768));
  }
  return Buffer.from(int16.buffer).toString("base64");
}

// Base64 PCM16 24kHz → float samples (from OpenAI or browser)
export function base64ToPcm24k(b64: string): Float32Array {
  const buf = Buffer.from(b64, "base64");
  const int16 = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) out[i] = int16[i] / 32768;
  return out;
}

// Full pipeline: Twilio μ-law 8kHz base64 → OpenAI PCM16 24kHz base64
export function twilioAudioToOpenAI(mulawB64: string): string {
  return pcm24kToBase64(upsample8kTo24k(pcm8kToFloat32(mulawB64)));
}

// Full pipeline: OpenAI PCM16 24kHz base64 → Twilio μ-law 8kHz base64
export function openAIAudioToTwilio(pcm24B64: string): string {
  return float32ToPcm8k(downsample24kTo8k(base64ToPcm24k(pcm24B64)));
}
