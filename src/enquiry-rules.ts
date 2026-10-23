// LEA-101 / LEA-33: the one place that turns the business's enquiry settings into rules for the assistant.
// The create_enquiry tool (during the call) and the after-call safety net both read these rules, so the two
// always create enquiries under exactly the same conditions.

import type { AssistantSettings } from "./config";

const MAX_DETAILS_LENGTH = 500;

const TRIGGER_LABELS: Record<string, string> = {
  cant_help: "you can't fully resolve the customer's request",
  wants_booking: "the customer wants to book a service",
  wants_quote: "the customer requests a quote",
  wants_human: "the customer asks to speak with a human",
  // Kept only for settings saved before this option was merged into cant_help.
  needs_support: "the customer needs support",
};

export interface EnquiryRules {
  /** Situations that create an enquiry, one sentence each. */
  conditions: string[];
  emailRequired: boolean;
  /** What else the owner wants to find out from the customer (free text), or null. */
  details: string | null;
}

export function buildEnquiryRules(settings: AssistantSettings | null): EnquiryRules {
  const triggers = Array.isArray(settings?.enquiries_trigger) ? settings.enquiries_trigger : ["cant_help"];
  const conditions = triggers.map((t) =>
    t === "custom" ? settings?.enquiries_trigger_custom ?? "a custom condition is met" : TRIGGER_LABELS[t] ?? t
  );
  const details = settings?.enquiries_extra_info?.replace(/\s+/g, " ").trim().slice(0, MAX_DETAILS_LENGTH) || null;
  return {
    conditions,
    emailRequired: !!(settings?.enquiries_required_fields ?? { email: false })["email"],
    details,
  };
}

/** Sentence for the live tool: the assistant has to ask during the call. */
export function enquiryEmailNote(rules: EnquiryRules): string {
  return rules.emailRequired ? " Also ask for their email address — it's required for this business." : "";
}

export function enquiryDetailsNote(rules: EnquiryRules): string {
  return rules.details
    ? ` Also ask the customer for the following and include it in the description: ${rules.details}`
    : "";
}

/** Sentence for the after-call check: nobody can ask any more, so it only reports what was said. */
export function enquiryDetailsNoteAfterCall(rules: EnquiryRules): string {
  return rules.details
    ? `\nThe business also wants to know the following from the customer: ${rules.details}\nIf the customer said any of it, include it in enquiry_description.`
    : "";
}
