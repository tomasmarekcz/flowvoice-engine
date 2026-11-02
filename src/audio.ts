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

// ─── Sample-rate conversion (8 kHz phone line ↔ 24 kHz OpenAI) ─────────────────
//
// Both directions run a low-pass filter before the rate changes, so nothing above 4 kHz folds back into the voice
// (aliasing, the harsh metallic sound of dropping samples), and they keep their filter memory between chunks, so
// the 20 ms chunks join without clicks. One converter per call and direction: it holds state.

const FACTOR = 3;
const TAPS = 72; // 24 per phase; a Blackman-windowed sinc cut at 3.8 kHz
const CUTOFF_HZ = 3800;
const RATE_HZ = 24000;

function lowPassKernel(): Float32Array {
  const h = new Float32Array(TAPS);
  const fc = CUTOFF_HZ / RATE_HZ;
  const mid = (TAPS - 1) / 2;
  let sum = 0;
  for (let n = 0; n < TAPS; n++) {
    const x = n - mid;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (TAPS - 1)) + 0.08 * Math.cos((4 * Math.PI * n) / (TAPS - 1));
    h[n] = sinc * w;
    sum += h[n];
  }
  for (let n = 0; n < TAPS; n++) h[n] /= sum; // unity gain at DC
  return h;
}

const KERNEL = lowPassKernel();

/** 8 kHz → 24 kHz. */
export class Upsampler {
  private history = new Float32Array(TAPS / FACTOR - 1);

  process(input: Float32Array): Float32Array {
    const per = TAPS / FACTOR;
    const buf = new Float32Array(this.history.length + input.length);
    buf.set(this.history);
    buf.set(input, this.history.length);
    const out = new Float32Array(input.length * FACTOR);
    for (let n = 0; n < input.length; n++) {
      const newest = this.history.length + n;
      for (let phase = 0; phase < FACTOR; phase++) {
        let acc = 0;
        for (let i = 0; i < per; i++) acc += KERNEL[i * FACTOR + phase] * buf[newest - i];
        out[n * FACTOR + phase] = acc * FACTOR;
      }
    }
    this.history = buf.slice(buf.length - this.history.length);
    return out;
  }
}

/** 24 kHz → 8 kHz. */
export class Downsampler {
  private history = new Float32Array(TAPS - 1);
  private consumed = 0; // input samples seen in earlier chunks
  private nextOut = 0; // stream index of the next output sample (every third input sample)

  process(input: Float32Array): Float32Array {
    const buf = new Float32Array(this.history.length + input.length);
    buf.set(this.history);
    buf.set(input, this.history.length);
    const out: number[] = [];
    const end = this.consumed + input.length;
    while (this.nextOut < end) {
      // buf[p] is the newest sample of the filter window that ends at stream index nextOut.
      const p = this.history.length + (this.nextOut - this.consumed);
      let acc = 0;
      for (let i = 0; i < TAPS; i++) acc += KERNEL[i] * buf[p - i];
      out.push(acc);
      this.nextOut += FACTOR;
    }
    this.consumed = end;
    this.history = buf.slice(buf.length - this.history.length);
    return Float32Array.from(out);
  }
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

/** The two conversions between a phone line (μ-law 8 kHz) and OpenAI (PCM16 24 kHz) for ONE connection. */
export class TelephonyConverter {
  private readonly up = new Upsampler();
  private readonly down = new Downsampler();

  /** Phone line → OpenAI. */
  toOpenAI(mulawB64: string): string {
    return pcm24kToBase64(this.up.process(pcm8kToFloat32(mulawB64)));
  }

  /** OpenAI → phone line. */
  toPhone(pcm24B64: string): string {
    return float32ToPcm8k(this.down.process(base64ToPcm24k(pcm24B64)));
  }
}

// ─── Looking at μ-law frames without converting them ──────────────────────────

/** True when every byte of a μ-law chunk is digital silence (0xFF or 0x7F). */
export function isSilentMulaw(mulawB64: string): boolean {
  const buf = Buffer.from(mulawB64, "base64");
  if (buf.length === 0) return true;
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0xff && buf[i] !== 0x7f) return false;
  return true;
}

/** Loudness of a μ-law chunk in dB relative to full scale (about -90 for near silence, 0 for a full-scale tone). */
export function mulawLevelDbfs(mulawB64: string): number {
  const buf = Buffer.from(mulawB64, "base64");
  if (buf.length === 0) return -Infinity;
  let energy = 0;
  for (let i = 0; i < buf.length; i++) {
    const s = mulawToLinear(buf[i]) / 32768;
    energy += s * s;
  }
  const rms = Math.sqrt(energy / buf.length);
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}
