// Which environment is this process, and is it allowed to contact a given recipient?
// Production is the default so that a missing APP_ENV can never silently *weaken*
// the production behavior; staging must opt in explicitly.

export type AppEnv = "production" | "staging";
type Env = Record<string, string | undefined>;

// Public project ref of the production Supabase project (not a secret).
export const PROD_SUPABASE_REF = "gnobailsforiruhyplnl";

export function getAppEnv(env: Env = process.env): AppEnv {
  return env.APP_ENV === "staging" ? "staging" : "production";
}

// Refuses to run when the environment label and the database disagree.
// Only enforced for real deployments (NODE_ENV=production) so local dev and tests are unaffected.
export function assertEnvironmentSafe(env: Env = process.env): void {
  if (env.NODE_ENV !== "production") return;
  const url = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const pointsAtProd = url.includes(PROD_SUPABASE_REF);
  const appEnv = getAppEnv(env);
  if (appEnv === "staging" && pointsAtProd) {
    throw new Error("Refusing to start: APP_ENV=staging but SUPABASE_URL is the production database.");
  }
  if (appEnv === "production" && !pointsAtProd) {
    throw new Error(
      "Refusing to start: APP_ENV is production but SUPABASE_URL is not the production database. " +
        "Set APP_ENV=staging on the staging server."
    );
  }
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Production contacts everyone. Staging contacts only allowlisted phones / e-mails
// (an entry starting with "@" allows a whole e-mail domain).
export function isRecipientAllowed(
  kind: "phone" | "email",
  to: string,
  env: Env = process.env
): boolean {
  if (getAppEnv(env) === "production") return true;
  if (kind === "phone") {
    const target = to.replace(/\s/g, "");
    return parseList(env.STAGING_ALLOWED_PHONES).some((p) => p.replace(/\s/g, "") === target);
  }
  const target = to.trim().toLowerCase();
  return parseList(env.STAGING_ALLOWED_EMAILS).some((entry) =>
    entry.startsWith("@") ? target.endsWith(entry) : entry === target
  );
}
