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
    const res = await fetch(
      `${url}/rest/v1/assistant_settings?project_id=eq.${projectId}&limit=1`,
      { headers }
    );
    const rows = (await res.json()) as AssistantSettings[];
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const settings = rows[0];

    if (settings.calendar_id) {
      const calRes = await fetch(
        `${url}/rest/v1/calendars?id=eq.${settings.calendar_id}&select=project_id&limit=1`,
        { headers }
      );
      const calRows = (await calRes.json()) as Array<{ project_id: string }>;
      settings._calendar_project_id = calRows?.[0]?.project_id ?? "admin-test";
    } else {
      settings._calendar_project_id = "admin-test";
    }

    return settings;
  } catch (e) {
    console.error("[config] loadAssistantSettings error:", (e as Error).message);
    return null;
  }
}
