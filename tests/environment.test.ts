import { describe, it, expect } from "vitest";
import {
  getAppEnv,
  assertEnvironmentSafe,
  isRecipientAllowed,
  PROD_SUPABASE_REF,
} from "../src/environment";

const PROD_URL = `https://${PROD_SUPABASE_REF}.supabase.co`;
const STAGING_URL = "https://abcdefghijklmnopqrst.supabase.co";

describe("getAppEnv", () => {
  it("defaults to production when APP_ENV is unset", () => {
    expect(getAppEnv({})).toBe("production");
  });
  it("returns staging only for the exact value 'staging'", () => {
    expect(getAppEnv({ APP_ENV: "staging" })).toBe("staging");
    expect(getAppEnv({ APP_ENV: "Staging " })).toBe("production");
  });
});

describe("assertEnvironmentSafe", () => {
  it("does nothing outside NODE_ENV=production (local dev, tests)", () => {
    expect(() =>
      assertEnvironmentSafe({ NODE_ENV: "test", APP_ENV: "staging", SUPABASE_URL: PROD_URL })
    ).not.toThrow();
  });
  it("refuses staging pointed at the production database", () => {
    expect(() =>
      assertEnvironmentSafe({ NODE_ENV: "production", APP_ENV: "staging", SUPABASE_URL: PROD_URL })
    ).toThrow(/staging.*production database/i);
  });
  it("refuses production pointed at a non-production database", () => {
    expect(() =>
      assertEnvironmentSafe({ NODE_ENV: "production", APP_ENV: "production", SUPABASE_URL: STAGING_URL })
    ).toThrow(/production.*not the production database/i);
  });
  it("accepts matching combinations", () => {
    expect(() =>
      assertEnvironmentSafe({ NODE_ENV: "production", APP_ENV: "staging", SUPABASE_URL: STAGING_URL })
    ).not.toThrow();
    expect(() =>
      assertEnvironmentSafe({ NODE_ENV: "production", SUPABASE_URL: PROD_URL })
    ).not.toThrow();
  });
  it("falls back to NEXT_PUBLIC_SUPABASE_URL", () => {
    expect(() =>
      assertEnvironmentSafe({ NODE_ENV: "production", APP_ENV: "staging", NEXT_PUBLIC_SUPABASE_URL: PROD_URL })
    ).toThrow();
  });
});

describe("isRecipientAllowed", () => {
  it("allows everything in production", () => {
    expect(isRecipientAllowed("phone", "+420111222333", {})).toBe(true);
    expect(isRecipientAllowed("email", "anyone@example.com", {})).toBe(true);
  });
  it("blocks everything on staging when no allowlist is configured", () => {
    expect(isRecipientAllowed("phone", "+420111222333", { APP_ENV: "staging" })).toBe(false);
  });
  it("allows listed phones on staging, ignoring spaces", () => {
    const env = { APP_ENV: "staging", STAGING_ALLOWED_PHONES: "+420 111 222 333, +420999888777" };
    expect(isRecipientAllowed("phone", "+420111222333", env)).toBe(true);
    expect(isRecipientAllowed("phone", "+420 999 888 777", env)).toBe(true);
    expect(isRecipientAllowed("phone", "+420000000000", env)).toBe(false);
  });
  it("allows listed emails case-insensitively and whole domains via @domain", () => {
    const env = { APP_ENV: "staging", STAGING_ALLOWED_EMAILS: "Tomas@Example.com, @leadoro.io" };
    expect(isRecipientAllowed("email", "tomas@example.com", env)).toBe(true);
    expect(isRecipientAllowed("email", "qa+1@leadoro.io", env)).toBe(true);
    expect(isRecipientAllowed("email", "customer@gmail.com", env)).toBe(false);
  });
});
