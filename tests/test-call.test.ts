import { afterEach, describe, it, expect, vi } from "vitest";
import { isTestCall, notificationPlan, notifyTestCallFinished } from "../src/test-call";

describe("test calls from the dashboard", () => {
  it("recognises a call from the QR code by having no Twilio call, even though it has a caller number", () => {
    expect(isTestCall(null)).toBe(true);
    expect(isTestCall("CA1")).toBe(false);
  });

  it("sends the owner's SMS and email only on the first test call, even when they are still switched off", () => {
    expect(notificationPlan(true, true)).toEqual({ forceGenerate: true, send: true });
  });

  it("later test calls write the texts into the call detail but send nothing", () => {
    expect(notificationPlan(true, false)).toEqual({ forceGenerate: true, send: false });
  });

  it("leaves real calls exactly as they were", () => {
    expect(notificationPlan(false, false)).toEqual({ forceGenerate: false, send: true });
  });
});

describe("telling the dashboard a test call is saved (LEA-190)", () => {
  const original = { ...process.env };
  afterEach(() => { process.env = { ...original }; vi.restoreAllMocks(); });

  it("posts the call id with the internal secret", async () => {
    process.env.ENGINE_INTERNAL_SECRET = "s3cret";
    process.env.FRONTEND_API_URL = "http://localhost:3000";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await notifyTestCallFinished("call-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3000/api/demo/call-finished");
    expect((init as RequestInit).headers).toMatchObject({ "x-internal-secret": "s3cret" });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ call_id: "call-1" });
  });

  it("does nothing without a call id or a secret, and never throws when the dashboard is down", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
    delete process.env.ENGINE_INTERNAL_SECRET;
    await notifyTestCallFinished("call-1");
    process.env.ENGINE_INTERNAL_SECRET = "s3cret";
    await notifyTestCallFinished(null);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(notifyTestCallFinished("call-1")).resolves.toBeUndefined();
  });
});
