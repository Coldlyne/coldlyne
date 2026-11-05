import { createHash } from "node:crypto";
import type { OAuthProvider } from "@/domain/connectors";
import type { Env } from "../env";
import { randomToken } from "../crypto/secrets";
import { requestJson } from "./http";

/**
 * Connecting a mailbox, a calendar or a sheet by signing in to Google or Microsoft: the
 * authorization code flow with PKCE, and refreshing the access token when it expires. The apps
 * are Coldlyne's own (their ids in the environment); the tokens are the workspace's, sealed.
 */

interface ProviderEndpoints {
  name: string;
  authorize: string;
  token: string;
  /** Parameters this provider needs for a refresh token and a fresh account choice. */
  extra: Record<string, string>;
}

const PROVIDERS: Record<OAuthProvider, ProviderEndpoints> = {
  google: {
    name: "Google",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    extra: { access_type: "offline", prompt: "consent select_account", include_granted_scopes: "true" },
  },
  microsoft: {
    name: "Microsoft",
    authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    extra: { prompt: "select_account" },
  },
};

export interface OAuthApp {
  clientId: string;
  clientSecret: string;
}

/** Coldlyne's app with this provider, or null when the instance hasn't registered one. */
export function oauthApp(provider: OAuthProvider, settings: Env): OAuthApp | null {
  const [clientId, clientSecret] = provider === "google" ? [settings.GOOGLE_CLIENT_ID, settings.GOOGLE_CLIENT_SECRET] : [settings.MICROSOFT_CLIENT_ID, settings.MICROSOFT_CLIENT_SECRET];
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** Where the provider sends the member back, for every connector. */
export const oauthCallbackUrl = (settings: Pick<Env, "BETTER_AUTH_URL">) => new URL("/api/connections/callback", settings.BETTER_AUTH_URL).toString();

export interface Authorization {
  url: string;
  state: string;
  codeVerifier: string;
}

/** The provider's sign-in page for these scopes, and what the callback needs to finish. */
export function authorizationUrl(provider: OAuthProvider, app: OAuthApp, scopes: readonly string[], redirectUri: string): Authorization {
  const state = randomToken(24);
  const codeVerifier = randomToken(48);
  const challenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const endpoints = PROVIDERS[provider];
  const params = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...endpoints.extra,
  });
  return { url: `${endpoints.authorize}?${params}`, state, codeVerifier };
}

/** The tokens kept, sealed, for a connection made by signing in. */
export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Milliseconds since the epoch, as a string: credentials are a string map. */
  expiresAt: string;
  scope: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

const tokensFrom = (response: TokenResponse, now: Date, previous?: OAuthTokens): OAuthTokens => ({
  accessToken: response.access_token,
  // Google sends a refresh token only the first time; a refresh keeps the one already held.
  refreshToken: response.refresh_token ?? previous?.refreshToken ?? "",
  expiresAt: String(now.getTime() + response.expires_in * 1000),
  scope: response.scope ?? previous?.scope ?? "",
});

async function tokenRequest(provider: OAuthProvider, body: Record<string, string>, fetchUrl: typeof fetch): Promise<TokenResponse> {
  const endpoints = PROVIDERS[provider];
  return requestJson<TokenResponse>(fetchUrl, endpoints.name, endpoints.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(body).toString(),
  });
}

/** Trades the code the provider sent back for the connection's tokens. */
export async function exchangeCode(provider: OAuthProvider, app: OAuthApp, code: string, codeVerifier: string, redirectUri: string, fetchUrl: typeof fetch, now: Date): Promise<OAuthTokens> {
  const response = await tokenRequest(provider, { grant_type: "authorization_code", code, code_verifier: codeVerifier, redirect_uri: redirectUri, client_id: app.clientId, client_secret: app.clientSecret }, fetchUrl);
  return tokensFrom(response, now);
}

/** A minute's margin, so a token never expires between the check and the call. */
const MARGIN_MS = 60_000;

export const expired = (tokens: OAuthTokens, now: Date) => Number(tokens.expiresAt) - MARGIN_MS <= now.getTime();

export async function refreshTokens(provider: OAuthProvider, app: OAuthApp, tokens: OAuthTokens, fetchUrl: typeof fetch, now: Date): Promise<OAuthTokens> {
  if (!tokens.refreshToken) throw new Error(`${PROVIDERS[provider].name} n’a pas donné de jeton de renouvellement : reconnectez ce compte.`);
  const response = await tokenRequest(provider, { grant_type: "refresh_token", refresh_token: tokens.refreshToken, client_id: app.clientId, client_secret: app.clientSecret }, fetchUrl);
  return tokensFrom(response, now, tokens);
}

/** Whether a set of credentials came from signing in (and so holds tokens to refresh). */
export const isOAuthTokens = (credentials: Record<string, string>): credentials is Record<string, string> & OAuthTokens => "accessToken" in credentials && "expiresAt" in credentials;
