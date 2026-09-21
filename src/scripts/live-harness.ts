// Usage:
//   OPENAI_API_KEY=... npx ts-node src/scripts/live-harness.ts caller.wav [--project <uuid>] [--real-tools] [--raw] [--out reply.wav] [--wait 15]
// caller.wav must be mono G.711 mu-law, 8 kHz (see the plan for the macOS `say` + `afconvert` recipe).
import { readFileSync, writeFileSync } from "fs";
import { WebSocket } from "ws";
import { LiveCallSession } from "../live-session";
import { loadAssistantSettings, type AssistantSettings } from "../config";

const args = process.argv.slice(2);
const wavPath = args.find((a) => !a.startsWith("--"));
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const realTools = args.includes("--real-tools");
const raw = args.includes("--raw");
const outPath = flag("--out") ?? "reply.wav";
const waitSeconds = Number(flag("--wait") ?? 15);
const projectId = flag("--project") ?? null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readMulawWav(path: string): Buffer {
  const buf = readFileSync(path);
  let pos = 12;
  let formatOk = false;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      formatOk = buf.readUInt16LE(pos + 8) === 7 && buf.readUInt32LE(pos + 12) === 8000;
    }
    if (id === "data") {
      if (!formatOk) throw new Error("WAV must be mu-law (format 7) at 8000 Hz");
      return buf.subarray(pos + 8, pos + 8 + size);
    }
    pos += 8 + size + (size % 2);
  }
  throw new Error("No data chunk found in WAV");
}

function writeMulawWav(path: string, data: Buffer): void {
  const h = Buffer.alloc(58);
  h.write("RIFF", 0); h.writeUInt32LE(50 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(18, 16); h.writeUInt16LE(7, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24); h.writeUInt32LE(8000, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34); h.writeUInt16LE(0, 36);
  h.write("fact", 38); h.writeUInt32LE(4, 42); h.writeUInt32LE(data.length, 46);
  h.write("data", 50); h.writeUInt32LE(data.length, 54);
  writeFileSync(path, Buffer.concat([h, data]));
}

async function main(): Promise<void> {
  if (!wavPath) throw new Error("Usage: live-harness.ts caller.wav [--project <uuid>] [--real-tools]");
  const audio = readMulawWav(wavPath);

  const fallbackSettings = {
    project_id: "harness",
    system_prompt: "You are a friendly receptionist for Acme Plumbing. Be brief.",
    capabilities: { enquiries: true, end_call: true },
    _project_name: "Acme Plumbing",
    greeting_enabled: false,
  } as unknown as AssistantSettings;
  const settings = (projectId ? await loadAssistantSettings(projectId) : null) ?? fallbackSettings;

  const reply: Buffer[] = [];
  let speechEndedAt = 0;
  let firstAudioAt = 0;
  const t0 = Date.now();
  const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`;

  const session = new LiveCallSession(
    settings,
    null, // null project id keeps DB logging off
    "+420000000000",
    null,
    {
      sendAudio: (b64) => {
        if (!firstAudioAt) {
          firstAudioAt = Date.now();
          if (speechEndedAt) console.log(`${stamp()} first reply audio (${firstAudioAt - speechEndedAt} ms after caller stopped)`);
        }
        reply.push(Buffer.from(b64, "base64"));
      },
      sendJson: (obj) => console.log(`${stamp()} json`, JSON.stringify(obj)),
      sendMark: (name) => console.log(`${stamp()} mark requested: ${name}`),
      endCall: () => console.log(`${stamp()} endCall requested`),
    },
    {
      // --raw prints every non-audio event from the server, to check payload shapes.
      connect: (url, apiKey) => {
        const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
        if (raw) {
          ws.on("message", (data) => {
            const text = data.toString();
            if (!text.includes('"session.output_audio.delta"')) console.log(`${stamp()} RAW ${text.slice(0, 500)}`);
          });
        }
        return ws;
      },
      ...(realTools
        ? {}
        : {
            executeTool: async (name: string, toolArgs: Record<string, unknown>) => {
              console.log(`${stamp()} TOOL ${name}`, JSON.stringify(toolArgs));
              return { result: { ok: true, note: "stubbed by harness" }, embeddingTokens: 0 };
            },
          }),
    }
  );

  await session.start();
  console.log(`${stamp()} session started`);

  for (let i = 0; i < audio.length; i += 160) {
    session.handleClientAudio(audio.subarray(i, i + 160).toString("base64"));
    await sleep(20);
  }
  // Trailing silence so server-side turn detection can close the caller's turn.
  const silence = Buffer.alloc(160, 0xff).toString("base64");
  for (let i = 0; i < 100; i++) {
    session.handleClientAudio(silence);
    await sleep(20);
  }
  speechEndedAt = Date.now();
  console.log(`${stamp()} caller audio finished, waiting ${waitSeconds}s for the reply`);

  await sleep(waitSeconds * 1000);
  await session.abort();

  const replyAudio = Buffer.concat(reply);
  writeMulawWav(outPath, replyAudio);
  console.log(`${stamp()} wrote ${replyAudio.length} bytes (${(replyAudio.length / 8000).toFixed(1)} s) to ${outPath}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
