import { eq, sql } from "drizzle-orm";
import { CONNECTORS, connectorOf, readFields, type Capability, type Connector, type ConnectorCategory, type ConnectorKind } from "@/domain/connectors";
import type { AdapterClient } from "@/infrastructure/connectors/adapter";
import { adapterOf } from "@/infrastructure/connectors";
import { expired, isOAuthTokens, oauthApp, refreshTokens, type OAuthTokens } from "@/infrastructure/connectors/oauth";
import { open, randomToken, seal, type Credentials } from "@/infrastructure/crypto/secrets";
import { connection } from "@/infrastructure/db/schema/connections";
import { withWorkspace } from "@/infrastructure/db/tenant";
import type { Database } from "@/infrastructure/db/client";
import { scheduledWorkChanged } from "@/infrastructure/scheduling/scheduled-work";
import type { Services } from "./services";

/** A connection as a member or an assistant sees it: never its credentials. */
export interface ConnectionView {
  id: string;
  kind: ConnectorKind;
  name: string;
  category: ConnectorCategory;
  label: string;
  status: "connected" | "failing";
  capabilities: readonly Capability[];
  checkedAt: Date | null;
  /** When what it brings in was last read, for connections that are asked rather than posted to. */
  syncedAt: Date | null;
  lastError: string | null;
  /** Why a mailbox was stopped before it hurt its domain; it sends nothing until a member resumes it. */
  pausedReason: string | null;
  /** Where the service posts back (replies, outcomes, bookings), for connectors that do. */
  hookUrl: string | null;
  /** What a receiver checks an outgoing webhook's signature with. */
  signingSecret: string | null;
}

type ConnectionRow = typeof connection.$inferSelect;

/** The signed address a connection's service posts its webhooks to. */
export const hookUrlOf = (services: Pick<Services, "settings">, row: Pick<ConnectionRow, "id" | "hookToken">) =>
  `${new URL(`/api/hooks/${row.id}`, services.settings.BETTER_AUTH_URL)}?token=${row.hookToken}`;

export function viewOf(services: Pick<Services, "settings">, row: ConnectionRow): ConnectionView {
  const connector = connectorOf(row.kind) as Connector;
  const posts = Boolean(connector.webhooks) || connector.authorization.kind === "inbound";
  return {
    id: row.id,
    kind: connector.kind,
    name: connector.name,
    category: connector.category,
    label: row.label,
    status: row.status,
    capabilities: connector.capabilities,
    checkedAt: row.checkedAt,
    syncedAt: row.syncedAt,
    lastError: row.lastError,
    pausedReason: row.pausedReason,
    hookUrl: posts ? hookUrlOf(services, row) : null,
    signingSecret: connector.kind === "webhook" ? row.hookToken : null,
  };
}

/** The catalogue as this instance offers it: a service signed in to through an app it hasn't registered can't be connected here. */
export const connectorsOffered = (settings: Services["settings"]) =>
  (CONNECTORS as readonly Connector[]).filter((connector) => connector.authorization.kind !== "oauth" || oauthApp(connector.authorization.provider, settings) !== null);

/** The workspace's connections, by category then name. */
export async function connectionsOf(services: Services, workspaceId: string): Promise<ConnectionView[]> {
  const rows = await withWorkspace(services.db, workspaceId, (tx) => tx.select().from(connection).orderBy(connection.kind, connection.label));
  return rows.filter((row) => connectorOf(row.kind)).map((row) => viewOf(services, row));
}

export type Connected = { ok: true; connection: ConnectionView } | { ok: false; error: string };

/**
 * Connects a service from what the member typed: checked against the service first, so a wrong
 * key is said at once rather than at the first send. Typing it again for the same account
 * replaces the saved credentials.
 */
export async function connectWithFields(services: Services, workspaceId: string, userId: string, kind: string, values: Record<string, unknown>): Promise<Connected> {
  const connector = connectorOf(kind);
  if (!connector || connector.authorization.kind === "oauth") return { ok: false, error: "Ce service se connecte en vous identifiant chez lui, pas avec des champs." };
  const read = readFields(connector, values);
  if (!read.ok) return { ok: false, error: `Il manque : ${read.missing.join(", ")}.` };
  const fields = read.values;
  const hookToken = randomToken(24);
  const check = await safeCheck(adapterOf(connector.kind)(contextFor(services, { id: "pending", hookToken }, fields, async () => "")));
  if (!check.ok) return { ok: false, error: check.detail };
  const { secrets, settings } = splitFields(connector, fields);
  const row = await saveConnection(services, workspaceId, { kind: connector.kind, label: check.label ?? connector.name, credentials: secrets, settings, hookToken, userId });
  return { ok: true, connection: viewOf(services, row) };
}

/** Secret fields are sealed; the others stay readable, for the screens. */
function splitFields(connector: Connector, fields: Record<string, string>): { secrets: Credentials; settings: Record<string, string> } {
  const secretKeys = new Set(connector.authorization.kind === "fields" ? connector.authorization.fields.filter((field) => field.secret).map((field) => field.key) : []);
  const entries = Object.entries(fields);
  return { secrets: Object.fromEntries(entries.filter(([key]) => secretKeys.has(key))), settings: Object.fromEntries(entries.filter(([key]) => !secretKeys.has(key))) };
}

export interface NewConnection {
  kind: ConnectorKind;
  label: string;
  credentials: Credentials;
  settings: Record<string, string>;
  hookToken: string;
  userId: string;
}

/** Saves a checked connection; the same account connected again keeps its row and hook address. */
export async function saveConnection(services: Services, workspaceId: string, created: NewConnection): Promise<ConnectionRow> {
  const sealedCredentials = seal(created.credentials, services.settings.COLDLYNE_SECRETS_KEY);
  const now = services.now();
  const saved = await withWorkspace(services.db, workspaceId, async (tx) => {
    const [row] = await tx
      .insert(connection)
      .values({ kind: created.kind, label: created.label, sealedCredentials, settings: created.settings, hookToken: created.hookToken, connectedBy: created.userId, checkedAt: now })
      .onConflictDoUpdate({
        target: [connection.workspaceId, connection.kind, connection.label],
        set: { sealedCredentials, settings: created.settings, status: "connected", lastError: null, checkedAt: now, updatedAt: sql`now()` },
      })
      .returning();
    return row;
  });
  scheduledWorkChanged();
  return saved;
}

/** Asks the service again whether the connection still works, and records the answer. */
export async function checkConnection(services: Services, workspaceId: string, connectionId: string): Promise<ConnectionView | null> {
  const opened = await openConnection(services, workspaceId, connectionId);
  if (!opened) return null;
  const check = await safeCheck(opened.client);
  const [row] = await withWorkspace(services.db, workspaceId, (tx) =>
    tx
      .update(connection)
      .set({ status: check.ok ? "connected" : "failing", lastError: check.ok ? null : check.detail, checkedAt: services.now() })
      .where(eq(connection.id, connectionId))
      .returning(),
  );
  return viewOf(services, row);
}

/** Forgets a connection and its credentials; what it brought in stays, with where it came from. */
export async function disconnect(services: Services, workspaceId: string, connectionId: string): Promise<boolean> {
  const deleted = await withWorkspace(services.db, workspaceId, (tx) => tx.delete(connection).where(eq(connection.id, connectionId)).returning({ id: connection.id }));
  scheduledWorkChanged();
  return deleted.length > 0;
}

export interface OpenedConnection {
  row: ConnectionRow;
  connector: Connector;
  client: AdapterClient;
}

/** A connection's client, its credentials opened, ready to talk to its service. */
export async function openConnection(services: Services, workspaceId: string, connectionId: string): Promise<OpenedConnection | null> {
  const [row] = await withWorkspace(services.db, workspaceId, (tx) => tx.select().from(connection).where(eq(connection.id, connectionId)));
  return row ? clientOf(services, workspaceId, row) : null;
}

/** The workspace's connections that can do this, opened. */
export async function connectionsWith(services: Services, workspaceId: string, capability: Capability): Promise<OpenedConnection[]> {
  const rows = await withWorkspace(services.db, workspaceId, (tx) => tx.select().from(connection).where(eq(connection.status, "connected")));
  return rows.filter((row) => (connectorOf(row.kind)?.capabilities as readonly Capability[] | undefined)?.includes(capability)).map((row) => clientOf(services, workspaceId, row));
}

export function clientOf(services: Services, workspaceId: string, row: ConnectionRow): OpenedConnection {
  const connector = connectorOf(row.kind) as Connector;
  const credentials = open(row.sealedCredentials, services.settings.COLDLYNE_SECRETS_KEY);
  const accessToken = accessTokenFor(services, workspaceId, row, connector, credentials);
  const fields = isOAuthTokens(credentials) ? row.settings : { ...row.settings, ...credentials };
  return { row, connector, client: adapterOf(connector.kind)(contextFor(services, row, fields, accessToken)) };
}

function contextFor(services: Services, row: Pick<ConnectionRow, "id" | "hookToken">, fields: Record<string, string>, accessToken: () => Promise<string>) {
  return { fields, accessToken, hookUrl: hookUrlOf(services, row), fetch: services.fetch, now: services.now };
}

/**
 * The access token of a connection made by signing in, refreshed (and saved, sealed) when it
 * has expired. Connections made with fields have none.
 */
function accessTokenFor(services: Services, workspaceId: string, row: ConnectionRow, connector: Connector, credentials: Credentials): () => Promise<string> {
  let tokens: OAuthTokens | null = isOAuthTokens(credentials) ? credentials : null;
  return async () => {
    if (!tokens || connector.authorization.kind !== "oauth") throw new Error(`${connector.name} ne se connecte pas en s’identifiant.`);
    if (!expired(tokens, services.now())) return tokens.accessToken;
    const app = oauthApp(connector.authorization.provider, services.settings);
    if (!app) throw new Error(`Cette instance n’a pas d’application ${connector.authorization.provider} configurée.`);
    const fresh = await refreshTokens(connector.authorization.provider, app, tokens, services.fetch, services.now());
    tokens = fresh;
    await saveCredentials(services.db, workspaceId, row.id, seal({ ...fresh }, services.settings.COLDLYNE_SECRETS_KEY));
    return fresh.accessToken;
  };
}

async function saveCredentials(db: Database, workspaceId: string, connectionId: string, sealedCredentials: string) {
  await withWorkspace(db, workspaceId, (tx) => tx.update(connection).set({ sealedCredentials }).where(eq(connection.id, connectionId)));
}

/** A check never throws: a service down or a refused key is an answer to show. */
export async function safeCheck(client: AdapterClient) {
  try {
    return await client.check();
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "Le service n’a pas répondu." };
  }
}
