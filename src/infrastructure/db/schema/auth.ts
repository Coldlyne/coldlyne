import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./shared";

// ─── Identity (Better Auth) ────────────────────────────────────────────────

export const user = pgTable("user", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: boolean().notNull().default(false),
  image: text(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const session = pgTable(
  "session",
  {
    id: text().primaryKey(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    token: text().notNull().unique(),
    ipAddress: text(),
    userAgent: text(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index().on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text().primaryKey(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamp({ withTimezone: true }),
    refreshTokenExpiresAt: timestamp({ withTimezone: true }),
    scope: text(),
    password: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index().on(table.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index().on(table.identifier)],
);

// ─── Assistants signing in (Better Auth's OAuth provider and its signing keys) ──
//
// Claude, ChatGPT and any MCP client register here (dynamic client registration), and a member
// grants them access on the consent page; the tokens they get are only good for Coldlyne's MCP
// server. Table and column names are the plugin's own, so its queries find them.

const userRef = () => text().references(() => user.id, { onDelete: "cascade" });
const sessionRef = () => text().references(() => session.id, { onDelete: "set null" });
const at = () => timestamp({ withTimezone: true });

export const oauthClient = pgTable("oauth_client", {
  id: text().primaryKey(),
  clientId: text().notNull().unique(),
  clientSecret: text(),
  clientDiscoveryId: text(),
  disabled: boolean().default(false),
  skipConsent: boolean(),
  enableEndSession: boolean(),
  subjectType: text(),
  scopes: text().array(),
  clientCredentialsScopes: text().array(),
  userId: userRef(),
  createdAt: at(),
  updatedAt: at(),
  name: text(),
  uri: text(),
  icon: text(),
  contacts: text().array(),
  tos: text(),
  policy: text(),
  softwareId: text(),
  softwareVersion: text(),
  softwareStatement: text(),
  redirectUris: text().array().notNull(),
  postLogoutRedirectUris: text().array(),
  backchannelLogoutUri: text(),
  backchannelLogoutSessionRequired: boolean(),
  tokenEndpointAuthMethod: text(),
  applicationType: text(),
  jwks: text(),
  jwksUri: text(),
  grantTypes: text().array(),
  responseTypes: text().array(),
  requirePKCE: boolean("require_pkce"),
  dpopBoundAccessTokens: boolean().default(false),
  referenceId: text(),
  metadata: jsonb(),
});

export const oauthResource = pgTable("oauth_resource", {
  id: text().primaryKey(),
  identifier: text().notNull().unique(),
  name: text().notNull(),
  accessTokenTtl: integer(),
  refreshTokenTtl: integer(),
  signingAlgorithm: text(),
  signingKeyId: text(),
  allowedScopes: text().array(),
  customClaims: jsonb(),
  dpopBoundAccessTokensRequired: boolean().default(false),
  disabled: boolean().default(false),
  createdAt: at(),
  updatedAt: at(),
  policyVersion: integer().default(1),
  metadata: jsonb(),
});

export const oauthClientResource = pgTable("oauth_client_resource", {
  id: text().primaryKey(),
  clientId: text()
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: "cascade" }),
  resourceId: text()
    .notNull()
    .references(() => oauthResource.identifier, { onDelete: "cascade" }),
  metadata: jsonb(),
  createdAt: at(),
});

export const oauthRefreshToken = pgTable(
  "oauth_refresh_token",
  {
    id: text().primaryKey(),
    token: text().notNull().unique(),
    clientId: text()
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: sessionRef(),
    userId: userRef().notNull(),
    referenceId: text(),
    authorizationCodeId: text(),
    resources: text().array(),
    requestedUserInfoClaims: text().array(),
    expiresAt: at(),
    createdAt: at(),
    revoked: at(),
    rotatedAt: at(),
    rotationReplayResponse: text(),
    rotationReplayExpiresAt: at(),
    authTime: at(),
    confirmation: jsonb(),
    scopes: text().array().notNull(),
  },
  (table) => [index().on(table.userId)],
);

export const oauthAccessToken = pgTable(
  "oauth_access_token",
  {
    id: text().primaryKey(),
    token: text().unique(),
    clientId: text()
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: sessionRef(),
    userId: userRef(),
    referenceId: text(),
    authorizationCodeId: text(),
    resources: text().array(),
    requestedUserInfoClaims: text().array(),
    refreshId: text().references(() => oauthRefreshToken.id, { onDelete: "cascade" }),
    expiresAt: at(),
    createdAt: at(),
    revoked: at(),
    confirmation: jsonb(),
    scopes: text().array().notNull(),
  },
  (table) => [index().on(table.userId)],
);

export const oauthConsent = pgTable(
  "oauth_consent",
  {
    id: text().primaryKey(),
    clientId: text()
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    userId: userRef(),
    referenceId: text(),
    resources: text().array(),
    requestedUserInfoClaims: text().array(),
    scopes: text().array().notNull(),
    createdAt: at(),
    updatedAt: at(),
  },
  (table) => [index().on(table.userId)],
);

export const oauthClientAssertion = pgTable("oauth_client_assertion", {
  id: text().primaryKey(),
  expiresAt: at().notNull(),
});

export const jwks = pgTable("jwks", {
  id: text().primaryKey(),
  publicKey: text().notNull(),
  privateKey: text().notNull(),
  createdAt: at().notNull(),
  expiresAt: at(),
  alg: text(),
  crv: text(),
});

/** Attempts per address and route, shared by every serverless instance: a limit kept in memory would be one per instance. */
export const rateLimit = pgTable("rate_limit", {
  id: text().primaryKey(),
  key: text().notNull().unique(),
  count: integer().notNull(),
  lastRequest: bigint({ mode: "number" }).notNull(),
});
