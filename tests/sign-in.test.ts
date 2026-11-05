import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountMail, companyLogin, signInOf } from "@/infrastructure/auth/sign-in";
import { expectFrenchTypography } from "./support/french";

const NOTHING = { OIDC_ISSUER: undefined, OIDC_CLIENT_ID: undefined, OIDC_CLIENT_SECRET: undefined, OIDC_NAME: "SSO", GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined, COLDLYNE_PASSWORD_SIGN_IN: false };
const COMPANY = { ...NOTHING, OIDC_ISSUER: "https://auth.example.com/api/auth", OIDC_CLIENT_ID: "client", OIDC_CLIENT_SECRET: "secret", OIDC_NAME: "Acme" };
const GOOGLE = { ...NOTHING, GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s" };

describe("the ways into an instance", () => {
  it("offers nothing until one is set up", () => {
    expect(signInOf(NOTHING)).toEqual({ provider: null, passwords: false });
    expect(companyLogin(NOTHING)).toBeNull();
  });

  it("offers Google, passwords or both, as they are set up", () => {
    expect(signInOf(GOOGLE)).toEqual({ provider: { id: "google", name: "Google" }, passwords: false });
    expect(signInOf({ ...NOTHING, COLDLYNE_PASSWORD_SIGN_IN: true })).toEqual({ provider: null, passwords: true });
    expect(signInOf({ ...GOOGLE, COLDLYNE_PASSWORD_SIGN_IN: true })).toEqual({ provider: { id: "google", name: "Google" }, passwords: true });
  });

  it("offers only the company's provider when it has one, under its name, whatever else is set", () => {
    expect(signInOf({ ...COMPANY, GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s", COLDLYNE_PASSWORD_SIGN_IN: true })).toEqual({ provider: { id: "oidc", name: "Acme" }, passwords: false });
    expect(companyLogin(COMPANY)).toMatchObject({ providerId: "oidc", discoveryUrl: "https://auth.example.com/api/auth/.well-known/openid-configuration", clientId: "client", scopes: ["openid", "profile", "email"], authentication: "basic" });
  });

  it.each(["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"])("needs %s to use a company's provider", (missing) => {
    expect(companyLogin({ ...COMPANY, [missing]: undefined })).toBeNull();
  });
});

describe("who may create an account", () => {
  // The list is read through env(), once: each test reads a fresh one.
  let sign: typeof import("@/infrastructure/auth/sign-in");

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("COLDLYNE_ADMINS", "founder@example.com");
    vi.stubEnv("COLDLYNE_DATABASE_URL", "postgres://user:password@localhost/coldlyne");
    vi.stubEnv("BETTER_AUTH_SECRET", "a".repeat(32));
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
    sign = await import("@/infrastructure/auth/sign-in");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lets a listed address in through a provider once the provider has verified it", () => {
    expect(sign.mayJoin({ email: "Founder@example.com", emailVerified: true })).toBe(true);
  });

  it.each([false, null, undefined])("refuses a listed address its provider marks %s: anyone could have typed it", (emailVerified) => {
    expect(sign.mayJoin({ email: "founder@example.com", emailVerified })).toBe(false);
  });

  it("refuses an address not on the list", () => {
    expect(sign.mayJoin({ email: "stranger@example.com", emailVerified: true })).toBe(false);
    expect(sign.passwordSignUpRefusal("stranger@example.com", { RESEND_API_KEY: "key" })).toContain("invitées");
  });

  it("lets someone with an invitation in through a provider, once the provider has verified the address", () => {
    expect(sign.mayJoin({ email: "invited@example.com", emailVerified: true }, true)).toBe(true);
    expect(sign.mayJoin({ email: "invited@example.com", emailVerified: false }, true)).toBe(false);
    expect(sign.mayJoin({ email: "invited@example.com" }, true)).toBe(false);
  });

  it("lets someone with an invitation sign up with a password, if the link proving it can be mailed", () => {
    expect(sign.passwordSignUpRefusal("invited@example.com", { RESEND_API_KEY: "key" }, true)).toBeNull();
    expect(sign.passwordSignUpRefusal("invited@example.com", { RESEND_API_KEY: undefined }, true)).toContain("lien de confirmation");
  });

  it("lets a listed address sign up with a password only if the link proving it can be mailed", () => {
    expect(sign.passwordSignUpRefusal("founder@example.com", { RESEND_API_KEY: "key" })).toBeNull();
    const refusal = sign.passwordSignUpRefusal("founder@example.com", { RESEND_API_KEY: undefined });
    expect(refusal).toContain("lien de confirmation");
    expectFrenchTypography(refusal as string);
  });
});

describe("the mails that prove an address", () => {
  it.each([
    ["confirm", accountMail.confirm],
    ["reset", accountMail.reset],
  ])("%s carries the link, and tells a stranger to ignore it", (_, mail) => {
    const { subject, text } = mail("https://coldlyne.test/link");
    expect(text).toContain("https://coldlyne.test/link");
    expect(text).toContain("ignorez ce message");
    expectFrenchTypography(subject);
    expectFrenchTypography(text.replace("https://coldlyne.test/link", ""));
  });
});
