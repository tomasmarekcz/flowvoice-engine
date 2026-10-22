import type { AssistantSettings } from "./config";
import { emptySnapshot, type PromptSnapshot } from "./prompts/core";
import { ENGINE_PROMPTS as P, ENGINE_TOOLS as T } from "./prompts/registry";

export interface OpenAITool {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

function getTodayLabel(): string {
  const now = new Date();
  const tz = "Europe/Prague";
  const f = (opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts }).format(now);
  return `${f({ weekday: "long" })} ${f({ day: "numeric" })}.${f({ month: "numeric" })}.${f({ year: "numeric" })}`;
}

// ─── Section 2: Business context — loaded from DB, shown to AI as facts ────────

function buildBusinessContext(settings: AssistantSettings | null, callerPhone: string | null | undefined, snapshot: PromptSnapshot): string {
  const lines: string[] = [
    snapshot.text(P.callBusinessContextIntro),
    "",
  ];

  if (settings?._project_name)        lines.push(`* Business name: ${settings._project_name}`);
  if (settings?._project_industry)    lines.push(`* Business type: ${settings._project_industry}`);
  if (settings?._project_description) lines.push(`* Business description: ${settings._project_description}`);
  if (settings?._project_website)     lines.push(`* Website: ${settings._project_website}`);
  if (settings?._project_language)    lines.push(`* Default language: ${languageName(settings._project_language)}`);

  const services = settings?._service_names ?? [];
  if (services.length > 0) {
    lines.push("");
    lines.push(`The business offers the following services: ${services.join(", ")}.`);
  }

  lines.push("");
  lines.push(`Today is ${getTodayLabel()}.`);

  if (callerPhone) {
    lines.push("");
    lines.push(snapshot.text(P.callerPhoneKnown, { phone: callerPhone }));
  }

  return lines.join("\n");
}

// ─── Section 4: Business instructions — editable by client in dashboard ────────

function buildBusinessInstructions(settings: AssistantSettings | null, snapshot: PromptSnapshot): string | null {
  const custom = settings?.system_prompt?.trim();
  if (!custom) return null;
  return snapshot.text(P.callBusinessInstructions, { instructions: custom });
}

// ─── Section 5: Greeting rule — injected when greeting_enabled is true ─────────

function buildGreetingRule(settings: AssistantSettings | null, snapshot: PromptSnapshot): string | null {
  if (!settings?.greeting_enabled) return null;
  const msg = settings.greeting_message?.trim();
  if (!msg) return null;
  return snapshot.text(P.callGreetingRule, { greeting: msg });
}

// ─── Public API ────────────────────────────────────────────────────────────────

// The dashboard stores the language as a code ("cs", "en"); older projects have a word.
function languageName(value: string): string {
  if (value === "cs") return "Czech";
  if (value === "en") return "English";
  return value;
}

export function buildPromptFromSettings(
  settings: AssistantSettings | null,
  callerPhone?: string | null,
  opts: { includeGreeting?: boolean } = {},
  snapshot: PromptSnapshot = emptySnapshot()
): string {
  const sections: string[] = [
    snapshot.text(P.callBase),
    buildBusinessContext(settings, callerPhone, snapshot),
    snapshot.text(P.callToolsPreamble),
  ];
  const instructions = buildBusinessInstructions(settings, snapshot);
  if (instructions) sections.push(instructions);
  if (opts.includeGreeting !== false) {
    const greeting = buildGreetingRule(settings, snapshot);
    if (greeting) sections.push(greeting);
  }
  return sections.join("\n\n");
}

export function buildTools(settings: AssistantSettings | null, snapshot: PromptSnapshot = emptySnapshot()): OpenAITool[] {
  const caps = settings?.capabilities ?? { calendar: true, lead_collection: true };
  const calendarProjectId = settings?._calendar_project_id ?? "admin-test";
  const tools: OpenAITool[] = [];
  // Wording comes from the prompt registry (editable in Admin → AI Settings); the code decides which tools exist,
  // their names, parameter types and which parameters are required.
  const describe = (tool: keyof typeof T, vars?: Record<string, string>) => snapshot.text(T[tool].description, vars);
  const param = (tool: keyof typeof T, name: string, type: string) => ({ type, description: snapshot.text(T[tool].params[name]) });

  if (caps["web_search"]) {
    const domains = settings?.web_search_domains ?? [];
    const domainNote = domains.length > 0
      ? ` Restricted to: ${domains.join(", ")}.`
      : " You can search the entire web.";
    tools.push({
      type: "function",
      name: "web_search",
      description: describe("web_search", { domain_note: domainNote }),
      parameters: {
        type: "object",
        properties: { query: param("web_search", "query", "string") },
        required: ["query"],
      },
    });
  }

  if (caps["enquiries"]) {
    const triggers = Array.isArray(settings?.enquiries_trigger)
      ? settings.enquiries_trigger
      : ["cant_help"];
    const triggerLabels: Record<string, string> = {
      cant_help: "you can't fully resolve the customer's request",
      wants_booking: "the customer wants to book a service",
      wants_quote: "the customer requests a quote",
      needs_support: "the customer needs support",
      custom: settings?.enquiries_trigger_custom ?? "a custom condition is met",
    };
    const triggerNote = triggers.map((t) => triggerLabels[t] ?? t).join("; ");
    const enquiryReqFields = settings?.enquiries_required_fields ?? { email: false };
    const enquiryRequired = ["title", "customer_phone", "customer_name"];
    if (enquiryReqFields["email"]) enquiryRequired.push("customer_email");
    tools.push({
      type: "function",
      name: "create_enquiry",
      description: describe("create_enquiry", {
        triggers: triggerNote,
        email_note: enquiryReqFields["email"] ? " Also ask for their email address — it's required for this business." : "",
      }),
      parameters: {
        type: "object",
        properties: {
          title: param("create_enquiry", "title", "string"),
          description: param("create_enquiry", "description", "string"),
          customer_phone: param("create_enquiry", "customer_phone", "string"),
          customer_name: param("create_enquiry", "customer_name", "string"),
          customer_email: param("create_enquiry", "customer_email", "string"),
        },
        required: enquiryRequired,
      },
    });
  }

  if (caps["calendar"]) {
    const bookingReqFields = settings?.booking_required_fields ?? { email: false };
    const bookingRequired = ["start_time", "end_time", "title", "customer_name", "customer_phone"];
    if (bookingReqFields["email"]) bookingRequired.push("customer_email");
    tools.push(
      {
        type: "function",
        name: "get_services",
        description: describe("get_services"),
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        type: "function",
        name: "get_resources",
        description: describe("get_resources"),
        parameters: {
          type: "object",
          properties: {
            service_id: param("get_resources", "service_id", "string"),
          },
          required: [],
        },
      },
      {
        type: "function",
        name: "get_day_availability",
        description: describe("get_day_availability", { calendar_project_id: calendarProjectId }),
        parameters: {
          type: "object",
          properties: {
            service_id: param("get_day_availability", "service_id", "string"),
            from_date: param("get_day_availability", "from_date", "string"),
            days: param("get_day_availability", "days", "number"),
          },
          required: ["from_date"],
        },
      },
      {
        type: "function",
        name: "create_calendar_event",
        description: describe("create_calendar_event", {
          email_note: bookingReqFields["email"] ? " Also ask for their email address — it's required for this business (e.g. to send a call link for online meetings)." : "",
        }),
        parameters: {
          type: "object",
          properties: {
            start_time: param("create_calendar_event", "start_time", "string"),
            end_time: param("create_calendar_event", "end_time", "string"),
            title: param("create_calendar_event", "title", "string"),
            customer_name: param("create_calendar_event", "customer_name", "string"),
            customer_phone: param("create_calendar_event", "customer_phone", "string"),
            customer_email: param("create_calendar_event", "customer_email", "string"),
            notes: param("create_calendar_event", "notes", "string"),
            service_id: param("create_calendar_event", "service_id", "string"),
            resource_id: param("create_calendar_event", "resource_id", "string"),
          },
          required: bookingRequired,
        },
      }
    );
  }

  if (caps["business_knowledge"]) {
    const topN = settings?.knowledge_top_n ?? 5;
    tools.push({
      type: "function",
      name: "search_knowledge",
      description: describe("search_knowledge", { top_n: String(topN) }),
      parameters: {
        type: "object",
        properties: {
          query: param("search_knowledge", "query", "string"),
        },
        required: ["query"],
      },
    });
  }

  if (caps["end_call"]) {
    tools.push({
      type: "function",
      name: "end_call",
      description: describe("end_call"),
      parameters: {
        type: "object",
        properties: {
          reason: param("end_call", "reason", "string"),
        },
        required: ["reason"],
      },
    });
  }

  return tools;
}
