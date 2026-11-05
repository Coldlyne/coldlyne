import { eq } from "drizzle-orm";
import { connectorOf } from "@/domain/connectors";
import { adapterOf } from "@/infrastructure/connectors";
import { authorizationUrl, exchangeCode, oauthApp, oauthCallbackUrl } from "@/infrastructure/connectors/oauth";
import { randomToken } from "@/infrastructure/crypto/secrets";
import { connectionGrant } from "@/infrastructure/db/schema/connections";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { hookUrlOf, safeCheck, saveConnection, viewOf, type Connected } from "./connections";
import type { Services } from "./services";

/** How long a member has to finish signing in to the provider. */
const GRANT_MINUTES = 10;

/**
 * Starts connecting a service by signing in to it (Gmail, Outlook, Google Agenda…): the provider's
 * page to send the member to, with the state and PKCE verifier kept until they come back.
 */
export async function startOAuthConnection(services: Services, workspaceId: string, userId: string, kind: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const connector = connectorOf(kind);
  if (connector?.authorization.kind !== "oauth") return { ok: false, error: "Ce service ne se connecte pas en s’identifiant chez lui." };
  const app = oauthApp(connector.authorization.provider, services.settings);
  if (!app) return { ok: false, error: `Cette instance n’a pas encore d’application ${connector.authorization.provider === "google" ? "Google" : "Microsoft"} : son administrateur doit en déclarer une.` };
  const authorization = authorizationUrl(connector.authorization.provider, app, connector.authorization.scopes, oauthCallbackUrl(services.settings));
  const expiresAt = new Date(services.now().getTime() + GRANT_MINUTES * 60_000);
  await withWorkspace(services.db, workspaceId, (tx) => tx.insert(connectionGrant).values({ state: authorization.state, kind: connector.kind, codeVerifier: authorization.codeVerifier, userId, expiresAt }));
  return { ok: true, url: authorization.url };
}

/**
 * Finishes it when the provider sends the member back: the grant must be theirs and still
 * fresh; the tokens are checked against the service (whose answer names the account) and
 * sealed. Grants are read by state before the workspace is known, on the trusted path.
 */
export async function finishOAuthConnection(services: Services, userId: string, state: string, code: string): Promise<Connected & { workspaceId?: string }> {
  const [grant] = await services.db.delete(connectionGrant).where(eq(connectionGrant.state, state)).returning();
  if (!grant || grant.userId !== userId || grant.expiresAt < services.now()) return { ok: false, error: "Cette connexion a expiré ou ne vous appartient pas : recommencez depuis Coldlyne." };
  const connector = connectorOf(grant.kind);
  if (connector?.authorization.kind !== "oauth") return { ok: false, error: "Service inconnu." };
  const app = oauthApp(connector.authorization.provider, services.settings);
  if (!app) return { ok: false, error: "Application OAuth absente." };
  const tokens = await exchangeCode(connector.authorization.provider, app, code, grant.codeVerifier, oauthCallbackUrl(services.settings), services.fetch, services.now());
  const hookToken = randomToken(24);
  const context = { fields: {}, accessToken: async () => tokens.accessToken, hookUrl: hookUrlOf(services, { id: "pending", hookToken }), fetch: services.fetch, now: services.now };
  const check = await safeCheck(adapterOf(connector.kind)(context));
  if (!check.ok) return { ok: false, error: check.detail };
  const label = check.label ?? connector.name;
  const row = await saveConnection(services, grant.workspaceId, { kind: connector.kind, label, credentials: { ...tokens }, settings: { address: label }, hookToken, userId });
  return { ok: true, workspaceId: grant.workspaceId, connection: viewOf(services, row) };
}
