import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CallWatchdog, containsGoodbye, endCallEnabled, maxCallMs, withTechnicalNotice,
  SILENCE_ASK_MS, SILENCE_HANGUP_MS, LIMIT_WARNING_BEFORE_MS,
} from "../src/call-ending";
import type { AssistantSettings } from "../src/config";

const texts = { silenceAsk: "ASK", silenceBye: "BYE", limitWarning: "WARN", limitBye: "LIMIT", reconnected: "BACK" };

function make(maxMs = 10 * 60_000) {
  const hooks = { speak: vi.fn(), sayAndHangUp: vi.fn(), hangUp: vi.fn(), texts };
  const dog = new CallWatchdog(hooks, maxMs);
  return { dog, hooks };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("silence (LEA-160)", () => {
  it("asks 'still there?' after 6 s, then says goodbye and hangs up after 6 s more", () => {
    const { dog, hooks } = make();
    dog.start();
    vi.advanceTimersByTime(SILENCE_ASK_MS - 1);
    expect(hooks.speak).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(hooks.speak).toHaveBeenCalledWith("ASK");
    vi.advanceTimersByTime(SILENCE_HANGUP_MS);
    expect(hooks.sayAndHangUp).toHaveBeenCalledWith("BYE", "silence");
  });

  it("starts counting when the assistant has finished speaking, not before", () => {
    const { dog, hooks } = make();
    dog.start();
    dog.assistantAudio(4000); // 4 s of speech is queued on the line
    vi.advanceTimersByTime(4000 + SILENCE_ASK_MS - 1);
    expect(hooks.speak).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(hooks.speak).toHaveBeenCalledWith("ASK");
  });

  it("the caller speaking starts the count again", () => {
    const { dog, hooks } = make();
    dog.start();
    vi.advanceTimersByTime(5000);
    dog.callerSpoke();
    vi.advanceTimersByTime(5000);
    expect(hooks.speak).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(hooks.speak).toHaveBeenCalledTimes(1);
  });

  it("an answer after the question cancels the goodbye", () => {
    const { dog, hooks } = make();
    dog.start();
    vi.advanceTimersByTime(SILENCE_ASK_MS);
    dog.callerSpoke();
    vi.advanceTimersByTime(SILENCE_HANGUP_MS + 100);
    expect(hooks.sayAndHangUp).not.toHaveBeenCalled();
  });

  it("does not count while a tool runs or the model is answering", () => {
    const { dog, hooks } = make();
    dog.start();
    dog.toolStarted();
    vi.advanceTimersByTime(30_000);
    expect(hooks.speak).not.toHaveBeenCalled();
    dog.toolFinished();
    dog.responseActive(true);
    vi.advanceTimersByTime(30_000);
    expect(hooks.speak).not.toHaveBeenCalled();
    dog.responseActive(false);
    vi.advanceTimersByTime(SILENCE_ASK_MS);
    expect(hooks.speak).toHaveBeenCalledWith("ASK");
  });

  it("does not count while suspended (hanging up, reconnecting)", () => {
    const { dog, hooks } = make();
    dog.start();
    dog.suspend(true);
    vi.advanceTimersByTime(60_000);
    expect(hooks.speak).not.toHaveBeenCalled();
    dog.suspend(false);
    vi.advanceTimersByTime(SILENCE_ASK_MS);
    expect(hooks.speak).toHaveBeenCalledTimes(1);
  });

  it("hangs up quietly when the assistant said goodbye, the line was left open and the caller is silent", () => {
    const { dog, hooks } = make();
    dog.start();
    dog.assistantSaid("Děkuji za zavolání, na shledanou.");
    vi.advanceTimersByTime(SILENCE_ASK_MS);
    expect(hooks.hangUp).toHaveBeenCalledWith("silence");
    expect(hooks.speak).not.toHaveBeenCalled();
  });

  it("a goodbye followed by the caller speaking does not hang up", () => {
    const { dog, hooks } = make();
    dog.start();
    dog.assistantSaid("goodbye");
    dog.callerSpoke();
    vi.advanceTimersByTime(SILENCE_ASK_MS);
    expect(hooks.hangUp).not.toHaveBeenCalled();
    expect(hooks.speak).toHaveBeenCalledWith("ASK");
  });
});

describe("call length limit (LEA-160)", () => {
  it("warns a minute before the end and says goodbye at the limit", () => {
    const { dog, hooks } = make(5 * 60_000);
    dog.start();
    // keep the line busy so silence does not interfere
    const keepTalking = setInterval(() => dog.callerSpoke(), 1000);
    vi.advanceTimersByTime(5 * 60_000 - LIMIT_WARNING_BEFORE_MS - 1);
    expect(hooks.speak).not.toHaveBeenCalledWith("WARN");
    vi.advanceTimersByTime(1);
    expect(hooks.speak).toHaveBeenCalledWith("WARN");
    vi.advanceTimersByTime(LIMIT_WARNING_BEFORE_MS);
    expect(hooks.sayAndHangUp).toHaveBeenCalledWith("LIMIT", "time_limit");
    clearInterval(keepTalking);
  });

  it("the limit runs even while the silence check is suspended", () => {
    const { dog, hooks } = make(3 * 60_000);
    dog.start();
    dog.suspend(true);
    vi.advanceTimersByTime(3 * 60_000);
    expect(hooks.sayAndHangUp).toHaveBeenCalledWith("LIMIT", "time_limit");
  });

  it("stop() cancels everything", () => {
    const { dog, hooks } = make(3 * 60_000);
    dog.start();
    dog.stop();
    vi.advanceTimersByTime(10 * 60_000);
    expect(hooks.speak).not.toHaveBeenCalled();
    expect(hooks.sayAndHangUp).not.toHaveBeenCalled();
  });
});

describe("helpers", () => {
  it("maxCallMs: default 10 minutes, clamped to 2-30", () => {
    expect(maxCallMs(null)).toBe(10 * 60_000);
    expect(maxCallMs({ max_call_minutes: 15 } as AssistantSettings)).toBe(15 * 60_000);
    expect(maxCallMs({ max_call_minutes: 1 } as AssistantSettings)).toBe(2 * 60_000);
    expect(maxCallMs({ max_call_minutes: 99 } as AssistantSettings)).toBe(30 * 60_000);
    expect(maxCallMs({ max_call_minutes: null } as AssistantSettings)).toBe(10 * 60_000);
  });

  it("end_call is on unless the customer switched it off", () => {
    expect(endCallEnabled(null)).toBe(true);
    expect(endCallEnabled({ capabilities: null } as AssistantSettings)).toBe(true);
    expect(endCallEnabled({ capabilities: { calendar: true } } as unknown as AssistantSettings)).toBe(true);
    expect(endCallEnabled({ capabilities: { end_call: false } } as unknown as AssistantSettings)).toBe(false);
  });

  it("spots a goodbye in Czech and English", () => {
    expect(containsGoodbye("Děkuji, na shledanou!")).toBe(true);
    expect(containsGoodbye("Hezký den.")).toBe(true);
    expect(containsGoodbye("Have a nice day")).toBe(true);
    expect(containsGoodbye("Můžete mi říct své jméno?")).toBe(false);
  });

  it("withTechnicalNotice adds the warning only for a technical ending, and gives an empty call a short summary", () => {
    const normal = withTechnicalNotice({ technical: false, ownerSms: "S", emailOwner: "E", ownerEnabled: true, emailEnabled: true, lang: "cs" });
    expect(normal).toEqual({ ownerSms: "S", emailOwner: "E" });
    const tech = withTechnicalNotice({ technical: true, ownerSms: "S", emailOwner: "E", ownerEnabled: true, emailEnabled: true, lang: "cs" });
    expect(tech.ownerSms).toBe("S");
    expect(tech.emailOwner).toContain("technické chybě");
    const empty = withTechnicalNotice({ technical: true, ownerSms: "", emailOwner: null, ownerEnabled: true, emailEnabled: false, lang: "en" });
    expect(empty.ownerSms).toContain("cut off");
    expect(empty.emailOwner).toBeNull();
    const off = withTechnicalNotice({ technical: true, ownerSms: "", emailOwner: null, ownerEnabled: false, emailEnabled: false, lang: "cs" });
    expect(off.ownerSms).toBeNull();
  });
});
