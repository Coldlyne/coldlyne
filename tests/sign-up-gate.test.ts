import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { inviteToWorkspace } from "@/application/invitations";
import type { Services } from "@/application/services";
import { SIGN_UP_REFUSED } from "@/domain/sign-up";
import { createAuth, type Auth } from "@/infrastructure/auth/server";
import type { Database } from "@/infrastructure/db/client";
import { user } from "@/infrastructure/db/schema/auth";
import type { Env } from "@/infrastructure/env";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { fakeFetch } from "./support/fetch";

vi.mock("server-only", () => ({}));
vi.mock("better-auth/next-js", () => ({ nextCookies: () => ({ id: "next-cookies" }) }));

const BASE = "http://localhost:3000";
const settings = {
  COLDLYNE_DATABASE_URL: "postgres://user:password@localhost/coldlyne",
  BETTER_AUTH_URL: BASE,
  BETTER_AUTH_SECRET: "a".repeat(32),
  COLDLYNE_ADMINS: "founder@example.com",
  COLDLYNE_PASSWORD_SIGN_IN: true,
  RESEND_API_KEY: "key",
  COLDLYNE_MAIL_FROM: "Coldlyne <contact@coldlyne.test>",
  OIDC_NAME: "SSO",
} as Env;
const PASSWORD = "correct horse battery";

let db: Database;
let auth: Auth;
let services: Services;
const mail = fakeFetch([{ match: "POST https://api.resend.com/emails", json: { id: "mail" } }]);

beforeAll(async () => {
  vi.stubEnv("COLDLYNE_ADMINS", settings.COLDLYNE_ADMINS);
  vi.stubEnv("COLDLYNE_DATABASE_URL", settings.COLDLYNE_DATABASE_URL);
  vi.stubEnv("BETTER_AUTH_SECRET", settings.BETTER_AUTH_SECRET);
  vi.stubEnv("BETTER_AUTH_URL", BASE);
  vi.stubGlobal("fetch", mail.fetch);
  db = await createTestDatabase();
  auth = createAuth(db, settings);
  services = { db, settings: { ...settings, RESEND_API_KEY: undefined }, fetch: mail.fetch, now: () => new Date() };
});
afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  mail.calls.length = 0;
});

const signUp = (email: string, callbackURL = "/") =>
  auth.handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email, password: PASSWORD, name: "Bea", callbackURL }),
    }),
  );

const accounts = async (email: string) => (await db.select().from(user)).filter((row) => row.email === email);

async function invite(email: string) {
  const seat = await createTestWorkspace(db);
  const invited = await inviteToWorkspace(services, seat.workspaceId, seat.userId, email, "member");
  if (!invited.ok || !invited.link) throw new Error("Not invited");
  return { ...seat, path: new URL(invited.link).pathname };
}

describe("signing up with a password", () => {
  it("refuses a stranger with a 422 the form can read, since a 403 here would pretend to succeed", async () => {
    const response = await signUp("stranger@example.com");
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: SIGN_UP_REFUSED, message: expect.stringContaining("invitées") });
    expect(await accounts("stranger@example.com")).toEqual([]);
    expect(mail.calls).toEqual([]);
  });

  it("lets an address with a live invitation get an account, unproved until the mailed link", async () => {
    const { path } = await invite("invited@example.com");
    const response = await signUp("invited@example.com", path);
    expect(response.status).toBe(200);
    const [account] = await accounts("invited@example.com");
    expect(account.emailVerified).toBe(false);
    await vi.waitFor(() => expect(mail.calls).toHaveLength(1));
    const sent = JSON.parse(mail.calls[0].body);
    expect(sent.to).toEqual(["invited@example.com"]);
    expect(decodeURIComponent(sent.text)).toContain(path);
  });

  it("matches the invitation whatever the capitals", async () => {
    await invite("capitals@example.com");
    expect((await signUp("Capitals@Example.com")).status).toBe(200);
  });

  it("keeps the door shut once the invitation is gone or has expired", async () => {
    const seat = await createTestWorkspace(db);
    const stale = { ...services, now: () => new Date(Date.now() - 15 * 86_400_000) };
    await inviteToWorkspace(stale, seat.workspaceId, seat.userId, "stale@example.com", "member");
    expect((await signUp("stale@example.com")).status).toBe(422);
  });

  it("still lets the instance's admins in, with no invitation", async () => {
    expect((await signUp("founder@example.com")).status).toBe(200);
  });

  it("refuses an invited address when no mail could prove it, as for anyone", async () => {
    await invite("nomail@example.com");
    const without = createAuth(db, { ...settings, RESEND_API_KEY: undefined });
    const response = await without.handler(new Request(`${BASE}/api/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: "nomail@example.com", password: PASSWORD, name: "Bea" }) }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ message: expect.stringContaining("lien de confirmation") });
  });
});

describe("arriving through an identity provider", () => {
  /** The gate as a provider's callback meets it: false sends the person back to the sign-in page. */
  const gate = (email: string, emailVerified: boolean) => (auth.options.databaseHooks?.user?.create?.before as (user: unknown, context: unknown) => Promise<unknown>)({ email, emailVerified, name: "Bea" }, { path: "/callback/oidc" });

  it("lets a verified address with a live invitation through", async () => {
    await invite("provider@example.com");
    expect(await gate("Provider@Example.com", true)).toBeUndefined();
  });

  it("refuses the same address unverified: anyone could have typed it", async () => {
    await invite("typed@example.com");
    expect(await gate("typed@example.com", false)).toBe(false);
  });

  it("refuses a verified stranger, and lets an admin through", async () => {
    expect(await gate("stranger@example.com", true)).toBe(false);
    expect(await gate("founder@example.com", true)).toBeUndefined();
  });
});
