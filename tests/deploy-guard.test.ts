import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Runs deploy/guard.sh against small fake dashboard / engine servers.
const GUARD = path.resolve(__dirname, "../deploy/guard.sh");

let dashboard: { status: number; body: unknown } = { status: 200, body: { blocking: false, summary: "" } };
let engine: { status: number; body: unknown } = { status: 200, body: { active: 0, calls: [] } };
const seen: Array<{ url: string; secret: string | undefined }> = [];
let servers: http.Server[] = [];
let ports = { dashboard: 0, engine: 0 };
let envFile = "";

function serve(get: () => { status: number; body: unknown }): Promise<http.Server> {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      seen.push({ url: req.url ?? "", secret: req.headers["x-internal-secret"] as string | undefined });
      const r = get();
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}

beforeAll(async () => {
  const d = await serve(() => dashboard);
  const e = await serve(() => engine);
  servers = [d, e];
  ports = { dashboard: (d.address() as { port: number }).port, engine: (e.address() as { port: number }).port };
  envFile = path.join(mkdtempSync(path.join(tmpdir(), "guard-")), ".env");
  writeFileSync(envFile, "OTHER=1\nENGINE_INTERNAL_SECRET=topsecret\n");
});
afterAll(() => servers.forEach((s) => s.close()));

function run(wait: number, force: 0 | 1, opts: { dashboardUrl?: string } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      "bash",
      ["-c", `source "${GUARD}"; wait_for_idle ${wait} ${force}`],
      {
        env: {
          ...process.env,
          ACTIVITY_ENV_FILE: envFile,
          ACTIVITY_DASHBOARD_URL: opts.dashboardUrl ?? `http://127.0.0.1:${ports.dashboard}`,
          ACTIVITY_ENGINE_URL: `http://127.0.0.1:${ports.engine}`,
          ACTIVITY_POLL_SECONDS: "1",
        },
      },
      (err, stdout, stderr) => resolve({ code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code as number) ?? 1 : 0, out: stdout + stderr }),
    );
  });
}

describe("deploy/guard.sh", () => {
  it("lets the deploy continue when nothing is running, and sends the internal secret", async () => {
    dashboard = { status: 200, body: { blocking: false, summary: "" } };
    seen.length = 0;
    const r = await run(0, 0);
    expect(r.code).toBe(0);
    expect(r.out).toContain("lze nasadit");
    expect(seen[0]).toMatchObject({ url: "/api/internal/activity", secret: "topsecret" });
  });

  it("refuses and says what runs when something is running and there is no waiting time", async () => {
    dashboard = { status: 200, body: { blocking: true, summary: "2 hovory (nejstarší 4 min), 1 zpracování dokumentu" } };
    const r = await run(0, 0);
    expect(r.code).toBe(1);
    expect(r.out).toContain("2 hovory (nejstarší 4 min), 1 zpracování dokumentu");
    expect(r.out).toContain("NESPUSTILO");
  });

  it("treats a running AI preparation as busy even with zero calls (red dot with 0 calls)", async () => {
    dashboard = { status: 200, body: { blocking: true, summary: "1 AI příprava po registraci" } };
    expect((await run(0, 0)).code).toBe(1);
  });

  it("waits and continues as soon as it is free", async () => {
    dashboard = { status: 200, body: { blocking: true, summary: "1 hovor" } };
    setTimeout(() => { dashboard = { status: 200, body: { blocking: false, summary: "" } }; }, 1500);
    const r = await run(1, 0);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Zkontroluji znovu");
    expect(r.out).toContain("lze nasadit");
  });

  it("gives up after the waiting time", async () => {
    dashboard = { status: 200, body: { blocking: true, summary: "1 hovor" } };
    const r = await run(0, 0);
    expect(r.code).toBe(1);
  });

  it("--force continues anyway and says so", async () => {
    dashboard = { status: 200, body: { blocking: true, summary: "1 hovor" } };
    const r = await run(0, 1);
    expect(r.code).toBe(0);
    expect(r.out).toContain("VYNUCENO");
  });

  it("falls back to the engine when the dashboard does not answer", async () => {
    engine = { status: 200, body: { active: 2, calls: [] } };
    const r = await run(0, 0, { dashboardUrl: "http://127.0.0.1:9" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("2 hovorů");
    engine = { status: 200, body: { active: 0, calls: [] } };
    expect((await run(0, 0, { dashboardUrl: "http://127.0.0.1:9" })).code).toBe(0);
  });

  it("stops, not continues, when an answer cannot be read (unknown must never look like free)", async () => {
    const garbage = http.createServer((_req, res) => { res.writeHead(200); res.end("<html>not json</html>"); });
    await new Promise<void>((r) => garbage.listen(0, "127.0.0.1", () => r()));
    const garbagePort = (garbage.address() as { port: number }).port;
    const r = await run(0, 0, { dashboardUrl: `http://127.0.0.1:${garbagePort}` });
    garbage.close();
    expect(r.code).toBe(1);
    expect(r.out).toContain("nelze přečíst");
  });

  it("continues with a warning when neither side can report (an older version), so the first release is possible", async () => {
    dashboard = { status: 404, body: {} };
    engine = { status: 404, body: {} };
    const r = await run(0, 0);
    expect(r.code).toBe(0);
    expect(r.out).toContain("UPOZORNĚNÍ");
    engine = { status: 200, body: { active: 0, calls: [] } };
  });
});
