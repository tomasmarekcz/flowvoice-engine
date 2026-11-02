// Phone simulator: runs the real Standard session against OpenAI with a fake Twilio line, so interruptions, noise and the
// audio format can be tried without a phone. The caller is raw 8 kHz mu-law files; the "phone" keeps a queue of what has
// been sent but not played, like Twilio does, and reports what a `clear` would have cut.
//
// Usage (the key is read from the environment, never from this repository):
//   OPENAI_API_KEY=... npx ts-node src/scripts/phone-sim.ts <interrupt|noise|ding|short> --dir <folder with a1.ulaw a2.ulaw ...>
//        [--audio pcmu|pcm24]
// Make the files with: say -v Zuzana -o a1.aiff "..." && ffmpeg -i a1.aiff -ar 8000 -ac 1 -f mulaw a1.ulaw
import { readFileSync } from "fs";
import { join } from "path";
import { CallSession } from "../session";
import { TelephonyConverter, mulawLevelDbfs } from "../audio";
import type { AssistantSettings } from "../config";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const scenario = args.find((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--")) ?? "interrupt";
const dir = flag("--dir") ?? ".";
const audio = (flag("--audio", "pcmu") as "pcmu" | "pcm24");

const file = (name: string) => readFileSync(join(dir, name));
const interruption = { interrupt: "a2.ulaw", noise: "noise300.ulaw", ding: "ding.ulaw", short: "short.ulaw" }[scenario] ?? "a2.ulaw";

const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(2).padStart(6);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The fake phone line: audio sent to the caller plays in real time, one chunk after another.
let playbackEndsAt = 0;
let heardStartedAt = 0;
let sentMs = 0;
let clears = 0;
const events: string[] = [];
const bytesToMs = (b64: string, fmt: "pcm24" | "mulaw8") => { const n = Buffer.from(b64, "base64").length; return fmt === "pcm24" ? n / 48 : n / 8; };
const converter = new TelephonyConverter();

const callbacks = {
  sendAudio: (b64: string, fmt: "pcm24" | "mulaw8" = "pcm24") => {
    const ms = bytesToMs(b64, fmt);
    const now = Date.now();
    if (!heardStartedAt || now > playbackEndsAt) heardStartedAt = heardStartedAt && now < playbackEndsAt ? heardStartedAt : now;
    playbackEndsAt = Math.max(now, playbackEndsAt) + ms;
    sentMs += ms;
  },
  clearAudio: () => {
    const unheard = Math.max(0, playbackEndsAt - Date.now());
    clears++;
    events.push(`${ts()}  CLEAR sent to the phone line; ${Math.round(unheard)} ms of speech had not been played yet`);
    playbackEndsAt = Date.now();
  },
  sendJson: (obj: unknown) => {
    const t = (obj as { type?: string })?.type;
    if (t === "input_audio_buffer.speech_started" || t === "input_audio_buffer.speech_stopped" || t === "response.created" || t === "response.done" || t === "engine.clear_audio") events.push(`${ts()}  ${t}${t === "response.done" ? ` (${(obj as { response?: { status?: string } }).response?.status})` : ""}`);
  },
  sendMark: () => {},
  endCall: () => {},
};

const settings = {
  project_id: "phone-sim",
  system_prompt: "Jsi česká recepční. Odpovídej česky, vždy alespoň šesti souvislými větami o tom, jak objednávka funguje.",
  capabilities: {},
  greeting_enabled: false,
  voice: "alloy",
} as unknown as AssistantSettings;

async function playCaller(buf: Buffer, session: CallSession): Promise<void> {
  for (let i = 0; i < buf.length; i += 160) {
    const frame = buf.subarray(i, i + 160).toString("base64");
    session.noteInboundFrame?.(i / 8, mulawLevelDbfs(frame));
    session.handleClientAudio(audio === "pcmu" ? frame : converter.toOpenAI(frame));
    await sleep(20);
  }
}
async function silence(session: CallSession, ms: number): Promise<void> {
  const frame = Buffer.alloc(160, 0xff).toString("base64");
  for (let i = 0; i < ms / 20; i++) { session.handleClientAudio(audio === "pcmu" ? frame : converter.toOpenAI(frame)); await sleep(20); }
}

async function main() {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
  const session = new CallSession(null, "+420000000000", null, callbacks, settings, undefined, { audio });
  await session.start();
  console.log(`${ts()}  scenario=${scenario} audio=${audio}`);
  await sleep(1200);
  console.log(`${ts()}  caller speaks (question)`);
  await playCaller(file("a1.ulaw"), session);
  await silence(session, 800);
  // Wait until the assistant's speech has been playing for 2.5 s, then the caller (or the noise) comes in over it.
  while (!heardStartedAt || Date.now() - heardStartedAt < 2500) await sleep(50);
  const unheardBefore = Math.max(0, playbackEndsAt - Date.now());
  console.log(`${ts()}  >>> ${scenario}: the caller makes a sound over the assistant (${Math.round(unheardBefore)} ms of speech still queued, ${Math.round(sentMs)} ms generated)`);
  const startedAt = Date.now();
  const clearsBefore = clears;
  await playCaller(file(interruption), session);
  await silence(session, 1500);
  await sleep(3500);
  console.log(events.join("\n"));
  const stopped = clears > clearsBefore;
  console.log(`${ts()}  RESULT: assistant ${stopped ? "was stopped" : "kept talking"}; clears=${clears}; assistant speech sent in total ${Math.round(sentMs)} ms (started ${(Date.now() - startedAt) / 1000}s ago)`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
