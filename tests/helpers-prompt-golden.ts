// LEA-63: computes every assembled prompt / tool list for a fixed set of fixtures, with a fixed clock.
// The golden fixture (tests/fixtures/prompts-golden.json) was captured from the code as it was BEFORE the
// prompt registry existed. tests/prompts-golden.test.ts proves the output is still byte-identical.
import { vi } from "vitest";
import { buildPromptFromSettings, buildTools } from "../src/prompt";
import { buildLiveGreetingInstruction, buildLiveSessionStart, buildLiveVoicePrompt } from "../src/live-protocol";
import { generateCallSummary, type SmsOptions } from "../src/call-logger";
import type { AssistantSettings } from "../src/config";

const base = {
  project_id: "proj-1", voice: "alloy", is_active: true, appointment_duration: 30, calendar_id: null, _calendar_project_id: "cal-9",
  sms_owner_enabled: false, sms_caller_enabled: false, sms_owner_instructions: null, sms_caller_instructions: null,
  email_owner_enabled: false, owner_phone: null, knowledge_top_n: null, web_search_domains: null,
  enquiries_trigger: null, enquiries_trigger_custom: null, enquiries_required_fields: null, booking_required_fields: null,
  greeting_enabled: false, greeting_message: null, system_prompt: null, capabilities: null,
} as unknown as AssistantSettings;

export const SETTINGS: Record<string, AssistantSettings | null> = {
  none: null,
  minimal: { ...base },
  full: {
    ...base,
    system_prompt: "Be kind.\nNever promise discounts.",
    capabilities: { web_search: true, enquiries: true, calendar: true, business_knowledge: true, end_call: true },
    web_search_domains: ["example.cz", "https://zdravi.cz/"],
    enquiries_trigger: ["cant_help", "wants_quote", "custom"],
    enquiries_trigger_custom: "the caller is upset",
    enquiries_required_fields: { email: true },
    booking_required_fields: { email: true },
    knowledge_top_n: 7,
    greeting_enabled: true,
    greeting_message: "Ordinace na Marjánce, dobrý den. Jak vám mohu pomoci?",
    _project_name: "Ordinace na Marjánce", _project_industry: "Dentist", _project_description: "Family dental clinic.",
    _project_website: "https://marjanka.example", _project_language: "cs", _service_names: ["Kontrola", "Čištění"],
  } as AssistantSettings,
  partial: {
    ...base,
    capabilities: { calendar: true, web_search: true, enquiries: true },
    enquiries_trigger: ["cant_help"],
    greeting_enabled: true,
    greeting_message: "Hello",
    _project_name: "Acme", _project_language: "en",
  } as AssistantSettings,
};

const SUMMARY_CASES: Array<{ name: string; sms: SmsOptions; language: string | null; enquiry: boolean }> = [
  { name: "off", sms: { smsOwnerEnabled: false, smsCallerEnabled: false, smsOwnerInstructions: null, smsCallerInstructions: null, emailOwnerEnabled: false }, language: null, enquiry: false },
  { name: "all-on-cs", sms: { smsOwnerEnabled: true, smsCallerEnabled: true, smsOwnerInstructions: "Short, with phone number.", smsCallerInstructions: null, emailOwnerEnabled: true }, language: "cs", enquiry: true },
  { name: "owner-default-en", sms: { smsOwnerEnabled: true, smsCallerEnabled: false, smsOwnerInstructions: "  ", smsCallerInstructions: null, emailOwnerEnabled: false }, language: "en", enquiry: false },
  { name: "caller-custom", sms: { smsOwnerEnabled: false, smsCallerEnabled: true, smsOwnerInstructions: null, smsCallerInstructions: "Say thanks $& {{x}}", emailOwnerEnabled: true }, language: "xx", enquiry: true },
];

async function summaryPrompt(c: (typeof SUMMARY_CASES)[number]): Promise<string> {
  let captured = "";
  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    captured = JSON.parse(init.body).messages[0].content as string;
    return { json: async () => ({ choices: [{ message: { content: "{}" } }], usage: {} }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  await generateCallSummary("key", [{ role: "user", text: "Hello" }] as never, c.sms, c.language, c.enquiry);
  vi.unstubAllGlobals();
  return captured;
}

export async function computeOutputs(): Promise<Record<string, unknown>> {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-22T10:00:00Z"));
  const out: Record<string, unknown> = {};
  try {
    for (const [name, s] of Object.entries(SETTINGS)) {
      const tools = buildTools(s);
      out[`${name}.standard`] = buildPromptFromSettings(s, "+420777123456");
      out[`${name}.standard.nogreeting.nophone`] = buildPromptFromSettings(s, null, { includeGreeting: false });
      out[`${name}.tools`] = tools;
      out[`${name}.live.voice`] = buildLiveVoicePrompt(s, tools);
      out[`${name}.live.greeting`] = buildLiveGreetingInstruction(s);
      out[`${name}.live.start`] = buildLiveSessionStart(s, "+420777123456").message;
    }
    for (const c of SUMMARY_CASES) out[`summary.${c.name}`] = await summaryPrompt(c);
  } finally {
    vi.useRealTimers();
  }
  return JSON.parse(JSON.stringify(out));
}
