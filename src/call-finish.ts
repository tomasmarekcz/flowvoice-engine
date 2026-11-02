// What happens when a call is over, for the engines that do not use the Standard session (Pipeline, LEA-165): the summary, the
// enquiry safety net, the SMS and e-mail, and the final write to the call row. It does the same as CallSession.end(); the
// Standard and Live sessions keep their own copy so they stay exactly as they were.
import { CallLogger, type UsageDetail, generateCallSummary, maybeCreatePostCallEnquiry, prepareEnquiryCheck, type SmsOptions, type TokenUsage, ZERO_TOKEN_USAGE } from "./call-logger";
import type { AssistantSettings } from "./config";
import { logger } from "./logger";
import type { PromptSnapshot } from "./prompts/core";
import { recordUsage } from "./prompts/store";
import { sendSmsNotifications, shouldSkipCallSms } from "./sms";
import { bookingsForSummary, callerSmsWithConfirmation, type ConfirmedBooking } from "./booking-confirmation";
import { fetchOwnerBookingBlock } from "./owner-booking-block";
import { planTestCallNotifications } from "./test-call";
import { formatOwnerSms } from "./session";
import type { QualityStats } from "./quality-tracker";

export interface FinishContext {
  logger: CallLogger;
  settings: AssistantSettings | null;
  projectId: string | null;
  callerPhone: string | null;
  twilioCallSid: string | null;
  promptSnapshot: PromptSnapshot;
  confirmedBookings: ConfirmedBooking[];
  bookingMade: boolean;
  searchEmbeddingTokens: number;
  quality: QualityStats;
  usageDetail: UsageDetail;
}

export async function finishCall(ctx: FinishContext): Promise<void> {
  const { logger: callLog, settings } = ctx;
  const apiKey = process.env.OPENAI_API_KEY ?? "";

  const skipSms = shouldSkipCallSms(callLog.callDurationSeconds, callLog.transcript);
  if (skipSms) logger.info("skipping SMS: short call or caller said nothing", { seconds: callLog.callDurationSeconds });

  const { testCall, plan } = await planTestCallNotifications(ctx.twilioCallSid, ctx.projectId, callLog.callId, skipSms);

  const smsOptions: SmsOptions | undefined = settings
    ? {
        smsOwnerEnabled: !skipSms && (plan.forceGenerate || (settings.sms_owner_enabled ?? false)),
        smsCallerEnabled: !skipSms && (settings.sms_caller_enabled ?? false),
        smsOwnerInstructions: settings.sms_owner_instructions ?? null,
        smsCallerInstructions: settings.sms_caller_instructions ?? null,
        emailOwnerEnabled: !skipSms && (plan.forceGenerate || (settings.email_owner_enabled ?? false)),
        confirmedBookings: ctx.confirmedBookings.length > 0 ? bookingsForSummary(ctx.confirmedBookings, settings._calendar_timezone ?? "Europe/Prague") : null,
      }
    : undefined;

  const enquiryRules = await prepareEnquiryCheck(settings, callLog.callId, ctx.projectId);

  const {
    title, summary, ownerSms, callerSms, emailOwner, summaryInputTokens, summaryOutputTokens,
    shouldCreateEnquiry, enquiryTitle, enquiryDescription, enquiryCustomerName, enquiryCustomerEmail,
  } = await generateCallSummary(apiKey, callLog.transcript, smsOptions, settings?._project_language ?? null, enquiryRules, ctx.promptSnapshot);
  recordUsage(ctx.promptSnapshot.usedVersionIds());

  await maybeCreatePostCallEnquiry({
    shouldCreate: shouldCreateEnquiry,
    callId: callLog.callId,
    projectId: ctx.projectId,
    callerPhone: ctx.callerPhone,
    enquiryTitle,
    enquiryDescription,
    customerName: enquiryCustomerName,
    customerEmail: enquiryCustomerEmail,
  });

  const bookingBlock = ownerSms && ctx.bookingMade ? await fetchOwnerBookingBlock(callLog.callId, ctx.projectId) : null;
  const ownerSmsFinal = ownerSms
    ? formatOwnerSms(ownerSms, {
        callerPhone: ctx.callerPhone,
        startMs: callLog.callStartMs,
        callId: callLog.callId,
        lang: settings?._project_language ?? null,
        booking: bookingBlock,
      })
    : null;

  const callerSmsFinal = callerSmsWithConfirmation(
    callerSms,
    ctx.confirmedBookings,
    {
      business: settings?._project_name ?? null,
      timezone: settings?._calendar_timezone ?? "Europe/Prague",
      language: settings?._project_language ?? null,
    },
    ctx.promptSnapshot
  );

  const { ownerSent, callerSent, ownerSid, callerSid } = await sendSmsNotifications({
    ownerSms: plan.send ? ownerSmsFinal : null,
    ownerPhone: settings?.owner_phone ?? null,
    callerSms: plan.send && !testCall ? callerSmsFinal : null,
    callerPhone: ctx.callerPhone,
  });

  const tokenUsage: TokenUsage = {
    ...ZERO_TOKEN_USAGE,
    summaryIn: summaryInputTokens,
    summaryOut: summaryOutputTokens,
    searchEmbedding: ctx.searchEmbeddingTokens,
  };

  await callLog.finalizeCall(title, summary, ownerSent, callerSent, ownerSmsFinal, callerSmsFinal, emailOwner, tokenUsage, { owner: ownerSid, caller: callerSid });
  await callLog.saveQuality(ctx.quality);
  await callLog.saveUsageDetail(ctx.usageDetail);

  if (plan.send && (plan.forceGenerate || settings?.email_owner_enabled) && emailOwner && callLog.callId) {
    const base = process.env.FRONTEND_API_URL ?? "http://localhost:3000";
    fetch(`${base}/api/notify/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        call_id: callLog.callId,
        project_id: ctx.projectId,
        email_body: emailOwner,
        caller_phone: ctx.callerPhone,
        ai_title: title,
        duration_seconds: callLog.callDurationSeconds,
        first_test_call: testCall && plan.send,
      }),
    }).catch((e) => logger.error("notify/call error", { err: e }));
  }
}
