import { describe, it, expect, afterAll } from "vitest";
import twilio from "twilio";
import { cfg, configured, supabaseGet, supabaseDelete, waitFor, simulateCall } from "./helpers";

const runId = `smoke-${Date.now()}`;

describe.skipIf(!configured)("staging smoke scenarios", () => {
  afterAll(async () => {
    await supabaseDelete(`calls?twilio_call_sid=like.CA${runId}*`);
    await supabaseDelete(`enquiries?title=eq.SMOKE%20${runId}`);
    await supabaseDelete(`calendar_events?title=eq.SMOKE%20${runId}`);
  });

  it("engine and dashboard health endpoints answer", async () => {
    const engine = await fetch(`${cfg.base}/health`);
    expect(await engine.json()).toEqual({ ok: true });
    const dash = await fetch(`${cfg.base}/api/health`);
    expect(await dash.json()).toEqual({ ok: true, env: "staging" });
  });

  it("the Twilio voice webhook rejects unsigned requests and answers signed ones", async () => {
    const url = `${cfg.base}/twilio/voice`;
    const params = { CallSid: `CA${runId}-w`, From: "sip:+420111222333@sip.zadarma.com", To: "+420000000000" };
    const unsigned = await fetch(`${url}?project_id=${cfg.projectId}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    expect(unsigned.status).toBe(403);

    const signature = twilio.getExpectedTwilioSignature(cfg.twilioToken, url, params);
    const signed = await fetch(`${url}?project_id=${cfg.projectId}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature },
      body: new URLSearchParams(params).toString(),
    });
    expect(signed.status).toBe(200);
    expect(await signed.text()).toContain("/ws/twilio");
  });

  it("a simulated call: assistant greets, and the call is saved with an end time", async () => {
    const callSid = `CA${runId}-c`;
    const { firstAudioMs } = await simulateCall({ callSid, callerPhone: "+420111222333" });
    expect(firstAudioMs).not.toBeNull();
    expect(firstAudioMs!).toBeLessThan(15_000); // latency budget for the first audio

    const row = await waitFor(async () => {
      const rows = await supabaseGet<{ ended_at: string | null; duration_seconds: number | null }>(
        `calls?twilio_call_sid=eq.${callSid}&select=ended_at,duration_seconds`
      );
      return rows[0]?.ended_at ? rows[0] : null;
    }, 45_000);
    expect(row.duration_seconds).toBeGreaterThanOrEqual(0);
  });

  it("assistant tools: availability lookup, enquiry and booking work through the dashboard API", async () => {
    const h = { "Content-Type": "application/json", "X-Internal-Secret": cfg.internalSecret };

    const slots = await fetch(
      `${cfg.base}/api/calendar/slots?project_id=${cfg.projectId}&from=${encodeURIComponent(new Date().toISOString())}`
    );
    expect(slots.ok).toBe(true);

    const enquiry = await fetch(`${cfg.base}/api/enquiries`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({
        project_id: cfg.projectId,
        title: `SMOKE ${runId}`,
        customer_phone: "+420111222333",
        status: "new",
      }),
    });
    expect(enquiry.ok).toBe(true);

    const start = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    start.setUTCHours(10, 0, 0, 0);
    const end = new Date(start.getTime() + 3600 * 1000);
    const event = await fetch(`${cfg.base}/api/calendar/events?project_id=${cfg.projectId}`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({
        title: `SMOKE ${runId}`,
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        customer_phone: "+420111222333",
        status: "pending_review",
        created_by: "ai",
        event_kind: "work",
      }),
    });
    expect(event.ok).toBe(true);
  });

  it("staging cannot be used to bill: the cron endpoint is disabled", async () => {
    const r = await fetch(`${cfg.base}/api/cron/billing-rollup`, {
      method: "POST",
      headers: { "x-cron-secret": "anything" },
    });
    expect(r.status).toBe(403);
  });
});
