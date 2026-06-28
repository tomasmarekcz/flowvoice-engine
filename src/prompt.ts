import type { AssistantSettings } from "./config";

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

function buildDefaultPrompt(): string {
  return `You are Alex, a professional and warm phone receptionist for a small service business. You speak with customers who call in.

Your main job is to help customers book appointments. You have access to the real business calendar.

When a customer wants to book a consultation, appointment, or service visit:
1. Understand what they need (ask one short question if unclear)
2. Ask the customer when they would roughly like the appointment — which day, and morning or afternoon preference
3. Call get_day_availability:
   - For a specific day: use days=1
   - For "this week" or "anytime soon": use days=5
   - For "next week" or when the customer is flexible: use days=7
4. Tell the customer which time blocks are free in plain language (e.g. "Monday morning is free from 9am to 1pm, and afternoon from 2pm to 5pm — when suits you?")
5. Once they choose a specific time, confirm the exact date and time back to them
6. Ask for their name and phone number
7. Call create_calendar_event:
   - start_time: compute from the window's from_utc + the offset of the customer's chosen time within the window (e.g. window from_utc="2026-06-30T07:00:00.000Z" = 09:00 Prague, customer picks 10:30 → start_time="2026-06-30T08:30:00.000Z")
   - end_time: start_time + appointment duration in minutes
8. Confirm the booking in one clear sentence

Rules:
- Keep every response SHORT — this is a phone call. One or two sentences maximum.
- Speak naturally, warmly, and professionally.
- Always respond in the same language the customer uses.
- Never make up available times — always call get_day_availability first.
- Never book a time outside the free windows returned by get_day_availability.
- If the customer has an urgent issue (emergency, safety), tell them to call emergency services.

Today is ${getTodayLabel()}.`;
}

export function buildPromptFromSettings(settings: AssistantSettings | null): string {
  const base = settings?.system_prompt?.trim();
  if (base) return `${base}\n\nToday is ${getTodayLabel()}.`;
  return buildDefaultPrompt();
}

export function buildTools(settings: AssistantSettings | null): OpenAITool[] {
  const caps = settings?.capabilities ?? { calendar: true, lead_collection: true };
  const calendarProjectId = settings?._calendar_project_id ?? "admin-test";
  const tools: OpenAITool[] = [];

  if (caps["web_search"]) {
    const domains = settings?.web_search_domains ?? [];
    const domainNote = domains.length > 0
      ? ` Restricted to: ${domains.join(", ")}.`
      : " You can search the entire web.";
    tools.push({
      type: "function",
      name: "web_search",
      description: `Search the web for current information when the customer asks something you don't know.${domainNote} Keep your answer to 2–3 sentences.`,
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "A concise search query." } },
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
    const reqFields = settings?.enquiries_required_fields ?? { name: true, email: false };
    tools.push({
      type: "function",
      name: "create_enquiry",
      description: `Flag this call for follow-up from the business owner. Use when: ${triggerNote}. ${reqFields["name"] ? "Always ask for the customer's name first. " : ""}After calling, confirm you've logged their request.`,
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short title describing the request" },
          description: { type: "string", description: "Brief summary of what the customer needs" },
          customer_phone: { type: "string", description: "Customer's phone number" },
          customer_name: { type: "string", description: "Customer's full name" },
          customer_email: { type: "string", description: "Customer's email address" },
        },
        required: ["title", "customer_phone"],
      },
    });
  }

  if (caps["calendar"]) {
    tools.push(
      {
        type: "function",
        name: "get_day_availability",
        description: `Get free time windows from the business calendar for one or more days. Returns blocks of available time, not individual slots — use these to tell the customer which hours are free, then let them pick a specific time within those blocks. Calendar project: ${calendarProjectId}. Always ask the customer which day (and rough time preference) before calling.`,
        parameters: {
          type: "object",
          properties: {
            from_date: {
              type: "string",
              description: "Starting date to check, YYYY-MM-DD (Prague timezone). Use today's date if the customer says 'today' or 'as soon as possible'.",
            },
            days: {
              type: "number",
              description: "How many calendar days to check starting from from_date. Use 1 for a specific day, 5 when customer says 'this week', 7 when customer is flexible or says 'next week'.",
            },
            duration_minutes: {
              type: "number",
              description: `Appointment duration in minutes. Default: ${settings?.appointment_duration ?? 60}.`,
            },
          },
          required: ["from_date"],
        },
      },
      {
        type: "function",
        name: "create_calendar_event",
        description: "Book an appointment after the customer confirms a specific slot. Created as pending_review.",
        parameters: {
          type: "object",
          properties: {
            start_time: { type: "string", description: "ISO 8601 start time" },
            end_time: { type: "string", description: "ISO 8601 end time" },
            title: { type: "string", description: "Short appointment title" },
            customer_name: { type: "string", description: "Customer name" },
            customer_phone: { type: "string", description: "Customer phone" },
            notes: { type: "string", description: "Optional notes" },
          },
          required: ["start_time", "end_time", "title"],
        },
      }
    );
  }

  return tools;
}
