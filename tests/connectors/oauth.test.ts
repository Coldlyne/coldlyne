import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authorizationUrl, exchangeCode, expired, isOAuthTokens, oauthApp, oauthCallbackUrl, refreshTokens } from "@/infrastructure/connectors/oauth";
import type { Env } from "@/infrastructure/env";
import { fakeFetch } from "../support/fetch";

const APP = { clientId: "app-id", clientSecret: "app-secret" };
const NOW = new Date("2026-11-04T09:00:00Z");

describe("connecting by signing in to a provider", () => {
  it("sends the member to Google with PKCE, offline access and the connector's scopes", () => {
    const { url, state, codeVerifier } = authorizationUrl("google", APP, ["openid", "https://www.googleapis.com/auth/gmail.send"], "https://coldlyne.test/api/connections/callback");
    const params = new URL(url).searchParams;
    expect(url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?")).toBe(true);
    expect(params.get("client_id")).toBe("app-id");
    expect(params.get("scope")).toBe("openid https://www.googleapis.com/auth/gmail.send");
    expect(params.get("access_type")).toBe("offline");
    expect(params.get("state")).toBe(state);
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toBe(createHash("sha256").update(codeVerifier).digest("base64url"));
  });

  it("trades the code for tokens, and knows when they expire", async () => {
    const { fetch, calls } = fakeFetch([{ match: "POST https://login.microsoftonline.com/common/oauth2/v2.0/token", json: { access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "Mail.Send" } }]);
    const tokens = await exchangeCode("microsoft", APP, "the-code", "the-verifier", "https://coldlyne.test/cb", fetch, NOW);
    expect(tokens).toEqual({ accessToken: "at", refreshToken: "rt", expiresAt: String(NOW.getTime() + 3_600_000), scope: "Mail.Send" });
    const sent = new URLSearchParams(calls[0].body);
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("code_verifier")).toBe("the-verifier");
    expect(expired(tokens, NOW)).toBe(false);
    expect(expired(tokens, new Date(NOW.getTime() + 3_590_000))).toBe(true);
    expect(isOAuthTokens({ ...tokens })).toBe(true);
    expect(isOAuthTokens({ apiKey: "k" })).toBe(false);
  });

  it("keeps the refresh token when a refresh doesn't send a new one", async () => {
    const { fetch } = fakeFetch([{ match: "POST https://oauth2.googleapis.com/token", json: { access_token: "new", expires_in: 3600 } }]);
    const fresh = await refreshTokens("google", APP, { accessToken: "old", refreshToken: "rt", expiresAt: "0", scope: "s" }, fetch, NOW);
    expect(fresh).toMatchObject({ accessToken: "new", refreshToken: "rt", scope: "s" });
  });

  it("asks to reconnect when there is nothing to refresh with", async () => {
    const { fetch } = fakeFetch([]);
    await expect(refreshTokens("google", APP, { accessToken: "a", refreshToken: "", expiresAt: "0", scope: "" }, fetch, NOW)).rejects.toThrow(/reconnectez/);
  });

  it("finds the instance's app per provider, or none", () => {
    const settings = { GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s", BETTER_AUTH_URL: "https://coldlyne.test" } as Env;
    expect(oauthApp("google", settings)).toEqual({ clientId: "g", clientSecret: "s" });
    expect(oauthApp("microsoft", settings)).toBeNull();
    expect(oauthCallbackUrl(settings)).toBe("https://coldlyne.test/api/connections/callback");
  });
});
