import { logger } from "./logger";

export interface SmsTargets {
  ownerSms: string | null;
  ownerPhone: string | null;
  callerSms: string | null;
  callerPhone: string | null;
}

async function sendOneSms(to: string, body: string): Promise<void> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_SMS_FROM ?? "FlowVoice";

  if (!accountSid || !authToken) {
    logger.warn("SMS not configured — TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN missing");
    return;
  }

  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const params = new URLSearchParams({ From: from, To: to, Body: body });

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
}

export async function sendSmsNotifications(
  targets: SmsTargets
): Promise<{ ownerSent: boolean; callerSent: boolean }> {
  let ownerSent = false;
  let callerSent = false;

  if (targets.ownerSms && targets.ownerPhone) {
    try {
      await sendOneSms(targets.ownerPhone, targets.ownerSms);
      ownerSent = true;
      logger.info("owner SMS sent", { to: targets.ownerPhone });
    } catch (e) {
      logger.error("owner SMS failed", { err: e });
    }
  }

  if (targets.callerSms && targets.callerPhone) {
    try {
      await sendOneSms(targets.callerPhone, targets.callerSms);
      callerSent = true;
      logger.info("caller SMS sent", { to: targets.callerPhone });
    } catch (e) {
      logger.error("caller SMS failed", { err: e });
    }
  }

  return { ownerSent, callerSent };
}
