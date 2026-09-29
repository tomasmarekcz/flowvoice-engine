import { logger } from "./logger";
import { isRecipientAllowed } from "./environment";
import type { TranscriptEntry } from "./call-logger";

// Calls shorter than this are just a greeting and a hang-up; an SMS would cost
// money and tell the owner nothing. The call itself still appears in the dashboard.
export const MIN_SMS_CALL_SECONDS = 15;

// True when a call is too short, or the caller never said anything, to be worth an SMS.
export function shouldSkipCallSms(durationSeconds: number, transcript: TranscriptEntry[]): boolean {
  if (durationSeconds < MIN_SMS_CALL_SECONDS) return true;
  return !transcript.some((t) => t.role === "user" && t.text.trim().length > 0);
}

// On staging only allowlisted phones may receive an SMS; production always passes.
function isAllowedTarget(to: string): boolean {
  if (isRecipientAllowed("phone", to)) return true;
  logger.warn("SMS blocked: recipient not in staging allowlist", { to_suffix: to.slice(-4) });
  return false;
}

export interface SmsTargets {
  ownerSms: string | null;
  ownerPhone: string | null;
  callerSms: string | null;
  callerPhone: string | null;
}

// Returns the Twilio message SID so delivery reports can be matched to the call later.
async function sendOneSms(to: string, body: string): Promise<string | null> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_SMS_FROM ?? "Leadoro";

  if (!accountSid || !authToken) {
    logger.warn("SMS not configured — TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN missing");
    return null;
  }

  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const params = new URLSearchParams({ From: from, To: to, Body: body });
  const engineHost = process.env.ENGINE_HOST;
  if (engineHost) params.set("StatusCallback", `https://${engineHost}/twilio/sms-status`);

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twilio SMS error ${res.status}: ${text}`);
  }
  const data = (await res.json().catch(() => null)) as { sid?: string } | null;
  return data?.sid ?? null;
}

export async function sendSmsNotifications(
  targets: SmsTargets
): Promise<{ ownerSent: boolean; callerSent: boolean; ownerSid: string | null; callerSid: string | null }> {
  let ownerSent = false;
  let callerSent = false;
  let ownerSid: string | null = null;
  let callerSid: string | null = null;

  if (targets.ownerSms && targets.ownerPhone && isAllowedTarget(targets.ownerPhone)) {
    try {
      ownerSid = await sendOneSms(targets.ownerPhone, targets.ownerSms);
      ownerSent = true;
      logger.info("owner SMS sent", { to: targets.ownerPhone });
    } catch (e) {
      logger.error("owner SMS failed", { err: e });
    }
  }

  if (targets.callerSms && targets.callerPhone && isAllowedTarget(targets.callerPhone)) {
    try {
      callerSid = await sendOneSms(targets.callerPhone, targets.callerSms);
      callerSent = true;
      logger.info("caller SMS sent", { to: targets.callerPhone });
    } catch (e) {
      logger.error("caller SMS failed", { err: e });
    }
  }

  return { ownerSent, callerSent, ownerSid, callerSid };
}
