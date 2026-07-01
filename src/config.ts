import { logger } from "./logger";

export interface AssistantSettings {
  project_id: string;
  system_prompt: string | null;
  voice: string | null;
  is_active: boolean;
  capabilities: Record<string, boolean> | null;
  appointment_duration: number | null;
  web_search_domains: string[] | null;
  enquiries_trigger: string[] | null;
  enquiries_trigger_custom: string | null;
  enquiries_required_fields: Record<string, boolean> | null;
  calendar_id: string | null;
  _calendar_project_id: string;
  sms_owner_enabled: boolean;
  sms_caller_enabled: boolean;
  sms_owner_instructions: string | null;
  sms_caller_instructions: string | null;
  owner_phone: string | null;
  // Joined from projects table
  _project_name?: string | null;
  _project_industry?: string | null;
  _project_description?: string | null;
  _project_website?: string | null;
  _project_language?: string | null;
  // Joined from event_types table
  _service_names?: string[];
}

function isUuid(str: string | null | undefined): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str ?? "");
}

export function getSupabaseUrl(): string {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL not set");
  return url;
}

export function getSupabaseHeaders(): Record<string, string> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
}

export async function loadAssistantSettings(
  projectId: string | null
): Promise<AssistantSettings | null> {
  if (!isUuid(projectId)) return null;
  try {
    const url = getSupabaseUrl();
    const headers = getSupabaseHeaders();

    const [settingsRes, projectRes] = await Promise.all([
      fetch(`${url}/rest/v1/assistant_settings?project_id=eq.${projectId}&limit=1`, { headers }),
      fetch(`${url}/rest/v1/projects?id=eq.${projectId}&select=owner_phone,name,industry,description,website,language&limit=1`, { headers }),
    ]);

    const rows = (await settingsRes.json()) as AssistantSettings[];
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const settings = rows[0];

    // Populate joined project fields
    const projectRows = (await projectRes.json()) as Array<{
      owner_phone: string | null;
      name: string | null;
      industry: string | null;
      description: string | null;
      website: string | null;
      language: string | null;
    }>;
    const proj = projectRows?.[0];
    settings.owner_phone = proj?.owner_phone ?? null;
    settings._project_name = proj?.name ?? null;
    settings._project_industry = proj?.industry ?? null;
    settings._project_description = proj?.description ?? null;
    settings._project_website = proj?.website ?? null;
    settings._project_language = proj?.language ?? null;

    if (settings.calendar_id) {
      const [calRows, etRows] = await Promise.all([
        fetch(`${url}/rest/v1/calendars?id=eq.${settings.calendar_id}&select=project_id&limit=1`, { headers })
          .then((r) => r.json() as Promise<Array<{ project_id: string }>>),
        fetch(`${url}/rest/v1/event_types?calendar_id=eq.${settings.calendar_id}&is_active=eq.true&select=name&order=name.asc`, { headers })
          .then((r) => r.json() as Promise<Array<{ name: string }>>),
      ]);
      settings._calendar_project_id = calRows?.[0]?.project_id ?? "admin-test";
      settings._service_names = Array.isArray(etRows) ? etRows.map((e) => e.name) : [];
    } else {
      settings._calendar_project_id = "admin-test";
      settings._service_names = [];
    }

    return settings;
  } catch (e) {
    logger.error("loadAssistantSettings error", { project_id: projectId, err: e });
    return null;
  }
}
