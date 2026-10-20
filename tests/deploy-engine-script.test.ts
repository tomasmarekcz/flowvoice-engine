import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Runs deploy/deploy-engine.sh with a fake docker and a fake activity server (LEA-80).
const ROOT = path.resolve(__dirname, "..");
let home = "", bin = "", busyFile = "", logFile = "", loadedFile = "";
let server: http.Server;
let port = 0;

beforeAll(async () => {
  home = mkdtempSync(path.join(tmpdir(), "deploy-engine-"));
  bin = path.join(home, "bin");
  busyFile = path.join(home, "busy");
  logFile = path.join(home, "calls.log");
  loadedFile = path.join(home, "loaded");
  mkdirSync(bin);
  mkdirSync(path.join(home, "deploy"));
  mkdirSync(path.join(home, "flowvoice-engine"));
  writeFileSync(path.join(home, "flowvoice-engine/.env"), "ENGINE_INTERNAL_SECRET=sec\n");
  writeFileSync(path.join(home, "image.tar.gz"), "x");
  copyFileSync(path.join(ROOT, "deploy/guard.sh"), path.join(home, "deploy/guard.sh"));

  const fake = (name: string, body: string) => {
    writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  fake("docker", `echo "docker $*" >> "${logFile}"
case "$1" in
  load) cat > /dev/null; echo loaded > "${loadedFile}" ;;
  image) if [[ "$2" == "inspect" ]]; then [[ -f "${loadedFile}" ]] && exit 0 || exit 1; fi ;;
esac
exit 0`);
  fake("gunzip", `cat "$2"`);
  fake("sleep", `exit 0`);
  fake("curl", `if [[ "$*" == *":8080/health"* ]]; then exit 0; fi
exec /usr/bin/curl "$@"`);

  server = http.createServer((_req, res) => {
    const busy = existsSync(busyFile);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ blocking: busy, summary: busy ? "2 hovory (nejstarší 4 min)" : "" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as { port: number }).port;
});
afterAll(() => { server.close(); rmSync(home, { recursive: true, force: true }); });
beforeEach(() => {
  rmSync(busyFile, { force: true });
  rmSync(loadedFile, { force: true });
  writeFileSync(logFile, "");
  writeFileSync(path.join(home, "deploy/engine.current"), "oldsha\n");
  writeFileSync(path.join(home, "deploy/engine.previous"), "older\n");
});

function run(args: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile("bash", ["-c", `"${ROOT}/deploy/deploy-engine.sh" ${args}`], {
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, ACTIVITY_DASHBOARD_URL: `http://127.0.0.1:${port}`, ACTIVITY_POLL_SECONDS: "0" },
    }, (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr }));
  });
}
const calls = () => readFileSync(logFile, "utf8");
const swapped = () => calls().includes("docker stop engine");
const current = () => readFileSync(path.join(home, "deploy/engine.current"), "utf8").trim();

describe("deploy-engine.sh", () => {
  it("loads the image and swaps the container when nothing runs", async () => {
    const r = await run(`newsha ${home}/image.tar.gz`);
    expect(r.code).toBe(0);
    expect(calls()).toContain("docker load");
    expect(swapped()).toBe(true);
    expect(current()).toBe("newsha");
  });

  it("does not touch the running container while a call runs", async () => {
    writeFileSync(busyFile, "x");
    const r = await run(`newsha ${home}/image.tar.gz`);
    expect(r.code).toBe(1);
    expect(r.out).toContain("2 hovory (nejstarší 4 min)");
    expect(swapped()).toBe(false);
    expect(current()).toBe("oldsha");
  });

  it("--force swaps even while a call runs", async () => {
    writeFileSync(busyFile, "x");
    const r = await run(`newsha ${home}/image.tar.gz --force`);
    expect(r.code).toBe(0);
    expect(swapped()).toBe(true);
  });

  it("--prepare only loads the image (no check, no swap)", async () => {
    writeFileSync(busyFile, "x");
    const r = await run(`--prepare newsha ${home}/image.tar.gz`);
    expect(r.code).toBe(0);
    expect(calls()).toContain("docker load");
    expect(swapped()).toBe(false);
  });

  it("--activate starts a loaded image, and refuses while a call runs", async () => {
    await run(`--prepare newsha ${home}/image.tar.gz`);
    writeFileSync(busyFile, "x");
    expect((await run("--activate newsha")).code).toBe(1);
    expect(swapped()).toBe(false);
    rmSync(busyFile);
    expect((await run("--activate newsha")).code).toBe(0);
    expect(swapped()).toBe(true);
    expect(current()).toBe("newsha");
  });

  it("--activate refuses an image that was never loaded", async () => {
    const r = await run("--activate nosuchsha");
    expect(r.code).toBe(1);
    expect(r.out).toContain("not loaded");
  });

  it("--rollback also waits for a quiet moment", async () => {
    writeFileSync(busyFile, "x");
    expect((await run("--rollback")).code).toBe(1);
    expect(swapped()).toBe(false);
    rmSync(busyFile);
    const ok = await run("--rollback");
    expect(ok.code).toBe(0);
    expect(current()).toBe("older");
  });
});
