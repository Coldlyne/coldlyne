import { createSign, generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth, type Auth } from "@/infrastructure/auth/server";
import type { Database } from "@/infrastructure/db/client";
import { account, user } from "@/infrastructure/db/schema/auth";
import type { Env } from "@/infrastructure/env";
import { createTestDatabase } from "./support/database";

vi.mock("server-only", () => ({}));
vi.mock("better-auth/next-js", () => ({ nextCookies: () => ({ id: "next-cookies" }) }));

const BASE = "http://localhost:3000";
const ISSUER = "https://idp.example";
const CLIENT = "the-client";
const FOUNDER = "founder@example.com";
const settings = {
  COLDLYNE_DATABASE_URL: "postgres://user:password@localhost/coldlyne",
  BETTER_AUTH_URL: BASE,
  BETTER_AUTH_SECRET: "a".repeat(32),
  COLDLYNE_ADMINS: FOUNDER,
  COLDLYNE_PASSWORD_SIGN_IN: false,
  OIDC_ISSUER: ISSUER,
  OIDC_CLIENT_ID: CLIENT,
  OIDC_CLIENT_SECRET: "the-client-secret",
  OIDC_NAME: "SSO",
} as Env;

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const round = { nonce: undefined as string | undefined, access: "PLAIN-ACCESS-TOKEN", refresh: "PLAIN-REFRESH-TOKEN", signing: keys.privateKey };

/** An id token as a provider signs one, for the nonce this sign-in asked for. */
function signedToken() {
  const now = Math.floor(Date.now() / 1000);
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const claims = { iss: ISSUER, aud: CLIENT, sub: "person-1", email: FOUNDER, email_verified: true, name: "Founder", iat: now, exp: now + 3600, ...(round.nonce ? { nonce: round.nonce } : {}) };
  const body = `${part({ alg: "RS256", kid: "k1" })}.${part(claims)}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(round.signing).toString("base64url")}`;
}

/** The identity provider, signing for real, on no network at all. */
const provider = (async (input: RequestInfo | URL) => {
  const url = input.toString();
  if (url.endsWith("/.well-known/openid-configuration")) return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, userinfo_endpoint: `${ISSUER}/userinfo`, jwks_uri: `${ISSUER}/jwks` });
  if (url === `${ISSUER}/token`) return Response.json({ access_token: round.access, refresh_token: round.refresh, id_token: signedToken(), token_type: "Bearer", expires_in: 3600 });
  if (url === `${ISSUER}/userinfo`) return Response.json({ sub: "person-1", email: FOUNDER, email_verified: true, name: "Founder" });
  if (url === `${ISSUER}/jwks`) return Response.json({ keys: [publicJwk] });
  throw new Error(`Unexpected ${url}`);
}) as typeof fetch;

const cookiesOf = (response: Response) => response.headers.getSetCookie().map((line) => line.split(";")[0]).join("; ");

let db: Database;
let auth: Auth;

async function signIn() {
  const started = await auth.handler(new Request(`${BASE}/api/auth/sign-in/social`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ provider: "oidc", callbackURL: "/" }) }));
  const { url } = (await started.json()) as { url: string };
  const asked = new URL(url).searchParams;
  round.nonce = asked.get("nonce") ?? undefined;
  const back = await auth.handler(new Request(`${BASE}/api/auth/callback/oidc?code=a-code&state=${encodeURIComponent(asked.get("state") as string)}`, { headers: { cookie: cookiesOf(started), origin: BASE } }));
  return { status: back.status, location: back.headers.get("location"), cookies: cookiesOf(back) };
}

const founderRow = async () => {
  const [row] = await db.select({ account }).from(account).innerJoin(user, eq(user.id, account.userId)).where(eq(user.email, FOUNDER));
  return row?.account;
};

const accessTokenWith = async (cookies: string) => {
  const body = JSON.stringify({ accountId: (await founderRow()).id });
  const response = await auth.handler(new Request(`${BASE}/api/auth/get-access-token`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie: cookies }, body }));
  return { status: response.status, token: ((await response.json()) as { accessToken?: string }).accessToken };
};

beforeAll(async () => {
  vi.stubEnv("COLDLYNE_ADMINS", FOUNDER);
  vi.stubEnv("COLDLYNE_DATABASE_URL", settings.COLDLYNE_DATABASE_URL);
  vi.stubEnv("BETTER_AUTH_SECRET", settings.BETTER_AUTH_SECRET);
  vi.stubEnv("BETTER_AUTH_URL", BASE);
  vi.stubGlobal("fetch", provider);
  db = await createTestDatabase();
  auth = createAuth(db, settings);
});
afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
beforeEach(async () => {
  Object.assign(round, { access: "PLAIN-ACCESS-TOKEN", refresh: "PLAIN-REFRESH-TOKEN", signing: keys.privateKey });
  await db.delete(user).where(eq(user.email, FOUNDER));
});

describe("a sign-in through a provider, its id token signed for real", () => {
  it("keeps its tokens sealed, and reads them back for whoever signed in", async () => {
    const { status, cookies } = await signIn();
    expect(status).toBe(302);
    const row = await founderRow();
    expect(row.accessToken).toBeTruthy();
    expect(row.accessToken).not.toContain("PLAIN");
    expect(row.refreshToken).not.toContain("PLAIN");
    expect(await accessTokenWith(cookies)).toEqual({ status: 200, token: "PLAIN-ACCESS-TOKEN" });
  });

  it("still reads a row stored in clear before tokens were sealed", async () => {
    const { cookies } = await signIn();
    await db.update(account).set({ accessToken: "stored.in.clear", refreshToken: "stored.refresh.in.clear" }).where(eq(account.userId, (await founderRow()).userId));
    expect(await accessTokenWith(cookies)).toEqual({ status: 200, token: "stored.in.clear" });
  });

  it("seals a row stored in clear the next time that person signs in, whatever its tokens look like", async () => {
    await signIn();
    // All hexadecimal: the one shape a token in clear can't be told from a sealed one by.
    await db.update(account).set({ accessToken: "abcdef0123456789", refreshToken: "0123456789abcdef" }).where(eq(account.userId, (await founderRow()).userId));
    round.access = "A-NEWER-ACCESS-TOKEN";
    const again = await signIn();
    expect(again.status).toBe(302);
    expect(again.location).not.toContain("error");
    const row = await founderRow();
    expect(row.accessToken).not.toContain("abcdef0123456789");
    expect(row.accessToken).not.toContain("A-NEWER");
    expect(await accessTokenWith(again.cookies)).toEqual({ status: 200, token: "A-NEWER-ACCESS-TOKEN" });
  });

  it("refuses an id token the provider didn't sign", async () => {
    round.signing = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const refused = await signIn();
    expect(refused.location).toContain("error");
    expect(await founderRow()).toBeUndefined();
  });
});
