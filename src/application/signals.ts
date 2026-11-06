import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import type { Capability } from "@/domain/connectors";
import { ProviderError } from "@/infrastructure/connectors/http";
import { sameSecret } from "@/infrastructure/crypto/secrets";
import { user } from "@/infrastructure/db/schema/auth";
import { connection, outreach, signal } from "@/infrastructure/db/schema/connections";
import { withWorkspace } from "@/infrastructure/db/tenant";
import type { Database } from "@/infrastructure/db/client";
import { sendOwnMail } from "@/infrastructure/mail/own-mail";
import type { Channel, InboundRequest, Notification, Signal, SignalType } from "./ports";
import { clientOf, connectionsWith, type OpenedConnection } from "./connections";
import { addToSuppressionList, reactToSignals } from "./enrollments";
import type { Services } from "./services";

/** What a STOP or a bounce puts on the suppression list, and why. */
const SUPPRESSES: Partial<Record<SignalType, "opted_out" | "bounced">> = { opted_out: "opted_out", bounced: "bounced" };

/** What a member wants to hear about as it happens. */
const NOTIFIES: Partial<Record<SignalType, Notification["event"]>> = { replied: "replied", meeting_booked: "meeting_booked", signed_up: "signed_up" };

/**
 * Keeps what a service reported, once each (by its own id), and only what concerns someone the
 * workspace reached out to: reading a mailbox or a calendar sees everything in it, and the rest
 * is none of Coldlyne's business (GDPR), so it is dropped and never stored. A STOP always
 * counts, whoever sends it. An opt-out or a bounce puts the address on the suppression list at
 * once, for every channel: nothing is ever sent to it again. Returns the signals that were new.
 */
export async function recordSignals(db: Database, workspaceId: string, connectionId: string | null, signals: readonly Signal[]): Promise<Signal[]> {
  if (signals.length === 0) return [];
  return withWorkspace(db, workspaceId, async (tx) => {
    const concerned = await concerningOutreach(tx, signals);
    if (concerned.length === 0) return [];
    const inserted = await tx
      .insert(signal)
      .values(concerned.map((found) => ({ connectionId, type: found.type, channel: found.channel, externalId: found.externalId, address: found.address, at: found.at, detail: found.detail ?? null, inReplyTo: found.inReplyTo ?? null })))
      .onConflictDoNothing()
      .returning({ externalId: signal.externalId });
    const fresh = new Set(inserted.map((row) => row.externalId));
    const added = concerned.filter((found) => fresh.has(found.externalId));
    const suppressed = added.flatMap((found) => (SUPPRESSES[found.type] && found.address ? [{ value: found.address, reason: SUPPRESSES[found.type]! }] : []));
    await addToSuppressionList(tx, suppressed);
    await reactToSignals(tx, added);
    return added;
  });
}

/** The signals about someone the workspace wrote to, by their address or by the message they answer. */
async function concerningOutreach(tx: Database, signals: readonly Signal[]): Promise<Signal[]> {
  const addresses = signals.flatMap((found) => (found.address ? [found.address] : []));
  const messageIds = signals.flatMap((found) => (found.inReplyTo ? [found.inReplyTo] : []));
  const reached = await tx
    .select({ address: outreach.address, messageId: outreach.messageId })
    .from(outreach)
    .where(or(addresses.length ? inArray(outreach.address, addresses) : undefined, messageIds.length ? inArray(outreach.messageId, messageIds) : undefined) ?? sql`false`);
  const known = new Set(reached.flatMap((row) => (row.messageId ? [row.address, row.messageId] : [row.address])));
  return signals.filter((found) => found.type === "opted_out" || (found.address !== null && known.has(found.address)) || (found.inReplyTo !== undefined && known.has(found.inReplyTo)));
}

/** Remembers that the workspace reached someone: what answers it will be kept. Every send goes through here. */
export async function recordOutreach(db: Database, workspaceId: string, sent: { connectionId: string | null; channel: Channel; address: string; messageId?: string; externalId?: string; enrollmentId?: string; at: Date }): Promise<void> {
  await withWorkspace(db, workspaceId, (tx) => tx.insert(outreach).values({ connectionId: sent.connectionId, channel: sent.channel, address: sent.address.trim().toLowerCase(), messageId: sent.messageId ?? null, externalId: sent.externalId ?? null, enrollmentId: sent.enrollmentId ?? null, sentAt: sent.at }));
}

/** Tells the workspace's alert connections (Slack, webhooks) about what deserves it. A failing one is marked, not fatal. */
export async function notifyAbout(services: Services, workspaceId: string, signals: readonly Signal[]): Promise<void> {
  const notifications = signals.flatMap((found) => notificationOf(services, found));
  if (notifications.length === 0) return;
  for (const opened of await connectionsWith(services, workspaceId, "notify")) {
    try {
      for (const notification of notifications) await opened.client.notify?.(notification);
    } catch (error) {
      await markFailing(services, workspaceId, opened.row.id, error);
    }
  }
}

function notificationOf(services: Services, found: Signal): Notification[] {
  const event = NOTIFIES[found.type];
  if (!event) return [];
  const who = found.address ?? "Quelqu’un";
  const title = event === "replied" ? `${who} a répondu` : event === "meeting_booked" ? `${who} a pris rendez-vous` : `${who} s’est inscrit`;
  return [{ event, title, text: found.detail ?? "", url: new URL("/signals", services.settings.BETTER_AUTH_URL).toString() }];
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : "Le service n’a pas répondu.");

/** Marks a connection as failing and, the first time it fails, tells the member who connected it. */
export async function markFailing(services: Services, workspaceId: string, connectionId: string, error: unknown) {
  const lastError = reasonOf(error);
  const before = await withWorkspace(services.db, workspaceId, async (tx) => {
    const [row] = await tx.select({ status: connection.status, label: connection.label, kind: connection.kind, connectedBy: connection.connectedBy }).from(connection).where(eq(connection.id, connectionId));
    await tx.update(connection).set({ status: "failing", lastError, checkedAt: services.now() }).where(eq(connection.id, connectionId));
    return row;
  });
  if (before?.status === "connected" && before.connectedBy) await mailFailing(services, before.connectedBy, before.kind, before.label, lastError);
}

/** A failing connection stops sending or reading, so its owner hears at once; a mail that can't leave changes nothing. */
export async function mailFailing(services: Services, userId: string, kind: string, label: string, why: string) {
  const [owner] = await services.db.select({ email: user.email }).from(user).where(eq(user.id, userId));
  if (!owner) return;
  const url = new URL(`/connections/${kind}`, services.settings.BETTER_AUTH_URL).toString();
  await sendOwnMail(services.settings, services.fetch, { to: owner.email, subject: `Coldlyne ne peut plus utiliser ${label}`, text: `${why}\n\nReconnectez ce compte ici : ${url}` }).catch(() => false);
}

export type HookAnswer = { status: number; body?: string; response?: Response };

/**
 * What a service posted to a connection's address: the address's token checked first (in
 * constant time), then the service's own signature by its adapter, then the signals kept and
 * the alerts sent. The connection is found by id before its workspace is known, on the trusted path.
 */
export async function receiveHook(services: Services, connectionId: string, token: string | null, request: InboundRequest): Promise<HookAnswer> {
  const [row] = await services.db.select().from(connection).where(eq(connection.id, connectionId));
  if (!row || !token || !sameSecret(token, row.hookToken)) return { status: 404 };
  const opened = clientOf(services, row.workspaceId, row);
  if (!opened.client.readWebhook) return { status: 404 };
  let read: Awaited<ReturnType<NonNullable<OpenedConnection["client"]["readWebhook"]>>>;
  try {
    read = await opened.client.readWebhook(request);
  } catch (error) {
    // Forged is the adapter's 401; anything else it can't read is the sender's to fix, or to send again.
    return { status: error instanceof ProviderError ? error.status : 400, body: error instanceof Error ? error.message : undefined };
  }
  const added = await recordSignals(services.db, row.workspaceId, row.id, read.signals);
  await notifyAbout(services, row.workspaceId, added);
  // Empty: some services (Twilio) read an answer's body as instructions.
  return read.reply ? { status: read.reply.status, response: read.reply } : { status: 200 };
}

/** The capabilities whose signals are read by asking the service, rather than posted by it. */
export const POLLED: Capability[] = ["read_replies", "meetings"];

/**
 * Reads what arrived on every connection that is asked rather than posted to (mailboxes, OVH's
 * incoming SMS, calendars), from where the last read stopped, with a day's overlap so nothing
 * slips between two reads; the ids keep it from being counted twice.
 */
export async function syncWorkspace(services: Services, workspaceId: string): Promise<{ read: number; added: number; failing: string[] }> {
  const result = { read: 0, added: 0, failing: [] as string[] };
  const seen = new Set<string>();
  for (const capability of POLLED) {
    for (const opened of await connectionsWith(services, workspaceId, capability)) {
      if (seen.has(opened.row.id)) continue;
      seen.add(opened.row.id);
      const outcome = await syncConnection(services, workspaceId, opened);
      if ("why" in outcome) result.failing.push(opened.row.label);
      else Object.assign(result, { read: result.read + outcome.read, added: result.added + outcome.added });
    }
  }
  return result;
}

const DAY_MS = 86_400_000;

/** Reads one connection from where its last read stopped: what it found and kept, or why it couldn't. */
export async function syncConnection(services: Services, workspaceId: string, opened: OpenedConnection): Promise<{ read: number; added: number } | { why: string }> {
  const now = services.now();
  const since = new Date((opened.row.syncedAt ?? new Date(now.getTime() - 7 * DAY_MS)).getTime() - DAY_MS);
  try {
    const found = [...((await opened.client.signalsSince?.(since)) ?? []), ...((await opened.client.meetingsSince?.(since)) ?? [])];
    const added = await recordSignals(services.db, workspaceId, opened.row.id, found);
    await withWorkspace(services.db, workspaceId, (tx) => tx.update(connection).set({ syncedAt: now, status: "connected", lastError: null }).where(eq(connection.id, opened.row.id)));
    await notifyAbout(services, workspaceId, added);
    return { read: found.length, added: added.length };
  } catch (error) {
    await markFailing(services, workspaceId, opened.row.id, error);
    return { why: reasonOf(error) };
  }
}

/** Every workspace that has a connection to read, for the scheduled sync (trusted path). */
export async function workspacesToSync(db: Database): Promise<string[]> {
  const rows = await db.selectDistinct({ workspaceId: connection.workspaceId }).from(connection).where(eq(connection.status, "connected"));
  return rows.map((row) => row.workspaceId);
}

export interface SignalView {
  type: SignalType;
  channel: string;
  address: string | null;
  at: Date;
  detail: string | null;
  from: string;
}

/** What came back lately, the latest first: replies, bounces, STOPs, outcomes, meetings, sign-ups. */
export async function signalsOf(db: Database, workspaceId: string, options: { since?: Date; types?: SignalType[]; limit?: number } = {}): Promise<SignalView[]> {
  const filters = [options.since ? gte(signal.at, options.since) : undefined, options.types?.length ? inArray(signal.type, options.types) : undefined].filter((filter) => filter !== undefined);
  return withWorkspace(db, workspaceId, (tx) =>
    tx
      .select({ type: signal.type, channel: signal.channel, address: signal.address, at: signal.at, detail: signal.detail, from: sql<string>`coalesce(${connection.label}, 'connexion retirée')` })
      .from(signal)
      .leftJoin(connection, eq(connection.id, signal.connectionId))
      .where(filters.length ? and(...filters) : sql`true`)
      .orderBy(desc(signal.at))
      .limit(Math.min(options.limit ?? 100, 500)),
  );
}
