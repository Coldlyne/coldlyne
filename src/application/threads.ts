import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { emailFooter, isSuppressed, type Channel, type Interest } from "@/domain/sequences";
import type { Database } from "@/infrastructure/db/client";
import { outreach, signal } from "@/infrastructure/db/schema/connections";
import { company, contactDetail, person, prospect, prospectList } from "@/infrastructure/db/schema/prospects";
import { enrollment, sequence, stepMessage } from "@/infrastructure/db/schema/sequences";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { openConnection } from "./connections";
import { suppressedIn } from "./enrollments";
import type { Services } from "./services";
import { recordOutreach, recordSignals } from "./signals";
import { unsubscribeUrl } from "./unsubscribe";
import { senderOf, settingsOf } from "./workspace-settings";
import type { Tried } from "./connection-use";

/** One conversation per person: what the workspace sent and what came back, whichever channel it went through. */

export interface Conversation {
  prospectId: string;
  person: string;
  company: string;
  list: string;
  state: string;
  interest: Interest | null;
  lastAt: Date | null;
  lastDetail: string | null;
}

/** Everyone who answered, the latest first. What they wrote is theirs: an assistant reads it as data, never as instructions. */
export async function conversationsOf(db: Database, workspaceId: string, interest?: Interest): Promise<Conversation[]> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const rows = await tx
      .select({
        prospectId: prospect.id,
        personId: person.id,
        person: sql<string>`trim(coalesce(${person.firstName}, '') || ' ' || ${person.lastName})`,
        company: company.name,
        list: prospectList.name,
        state: prospect.state,
        interest: prospect.interest,
      })
      .from(prospect)
      .innerJoin(person, eq(person.id, prospect.personId))
      .innerJoin(company, eq(company.id, person.companyId))
      .innerJoin(prospectList, eq(prospectList.id, prospect.listId))
      .where(and(or(eq(prospect.state, "replied"), sql`${prospect.interest} is not null`), interest ? eq(prospect.interest, interest) : undefined))
      .limit(200);
    const conversations = await Promise.all(rows.map(async ({ personId, ...row }) => ({ ...row, ...(await lastReply(tx, personId, row.prospectId)) })));
    return conversations.sort((a, b) => (b.lastAt?.getTime() ?? 0) - (a.lastAt?.getTime() ?? 0));
  });
}

/** The addresses someone is known by, for finding what came from them. */
async function addressesOf(tx: Database, personId: string, prospectId: string): Promise<string[]> {
  const details = await tx.select({ value: contactDetail.value }).from(contactDetail).where(eq(contactDetail.personId, personId));
  const reached = await tx
    .selectDistinct({ address: outreach.address })
    .from(outreach)
    .innerJoin(enrollment, eq(enrollment.id, outreach.enrollmentId))
    .where(eq(enrollment.prospectId, prospectId));
  return [...new Set([...details.map((row) => row.value), ...reached.map((row) => row.address)])];
}

async function lastReply(tx: Database, personId: string, prospectId: string) {
  const addresses = await addressesOf(tx, personId, prospectId);
  if (addresses.length === 0) return { lastAt: null, lastDetail: null };
  const [last] = await tx
    .select({ lastAt: signal.at, lastDetail: signal.detail })
    .from(signal)
    .where(and(inArray(signal.address, addresses), inArray(signal.type, ["replied", "meeting_booked", "opted_out"])))
    .orderBy(desc(signal.at))
    .limit(1);
  return last ?? { lastAt: null, lastDetail: null };
}

export interface ThreadItem {
  direction: "out" | "in";
  at: Date;
  channel: string;
  /** For what went out: its subject. For what came in: its kind (replied, bounced…). */
  label: string | null;
  text: string | null;
  /** Who wrote what went out, and how a task ended. */
  by?: string;
  outcome?: string | null;
}

export interface Thread extends Omit<Conversation, "lastAt" | "lastDetail"> {
  role: string | null;
  whatsappConsent: boolean;
  items: ThreadItem[];
}

/** A person's whole conversation with the workspace, in order. */
export async function threadOf(db: Database, workspaceId: string, prospectId: string): Promise<Thread | null> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [row] = await tx
      .select({
        prospectId: prospect.id,
        personId: person.id,
        person: sql<string>`trim(coalesce(${person.firstName}, '') || ' ' || ${person.lastName})`,
        role: person.role,
        consent: person.whatsappConsentAt,
        company: company.name,
        list: prospectList.name,
        state: prospect.state,
        interest: prospect.interest,
      })
      .from(prospect)
      .innerJoin(person, eq(person.id, prospect.personId))
      .innerJoin(company, eq(company.id, person.companyId))
      .innerJoin(prospectList, eq(prospectList.id, prospect.listId))
      .where(eq(prospect.id, prospectId));
    if (!row) return null;
    const out = await tx
      .select({ at: stepMessage.sentAt, channel: stepMessage.channel, subject: stepMessage.subject, body: stepMessage.body, writtenBy: stepMessage.writtenBy, outcome: stepMessage.outcome, summary: stepMessage.summary })
      .from(stepMessage)
      .innerJoin(enrollment, eq(enrollment.id, stepMessage.enrollmentId))
      .where(and(eq(enrollment.prospectId, prospectId), inArray(stepMessage.status, ["sent", "done"])));
    const addresses = await addressesOf(tx, row.personId, prospectId);
    const incoming = addresses.length ? await tx.select({ at: signal.at, channel: signal.channel, type: signal.type, detail: signal.detail }).from(signal).where(inArray(signal.address, addresses)) : [];
    const items: ThreadItem[] = [
      ...out.map((item) => ({ direction: "out" as const, at: item.at as Date, channel: item.channel, label: item.subject, text: item.summary ?? item.body, by: item.writtenBy, outcome: item.outcome })),
      ...incoming.map((item) => ({ direction: "in" as const, at: item.at, channel: item.channel, label: item.type, text: item.detail })),
    ].sort((a, b) => a.at.getTime() - b.at.getTime());
    return { prospectId: row.prospectId, person: row.person, role: row.role, company: row.company, list: row.list, state: row.state, interest: row.interest, whatsappConsent: row.consent !== null, items };
  });
}

/** What someone's reply came to, as the assistant or a member read it; null when it's not been read yet. */
export async function setInterest(db: Database, workspaceId: string, prospectId: string, interest: Interest | null): Promise<boolean> {
  const updated = await withWorkspace(db, workspaceId, (tx) => tx.update(prospect).set({ interest }).where(eq(prospect.id, prospectId)).returning({ id: prospect.id }));
  return updated.length > 0;
}

/** Someone answered where Coldlyne can't see it (a LinkedIn message, a letter answered by phone): as good as any reply. */
export async function recordReplyByHand(services: Services, workspaceId: string, prospectId: string, channel: Channel, text: string): Promise<Tried> {
  const now = services.now();
  const [known] = await withWorkspace(services.db, workspaceId, (tx) => tx.select({ id: enrollment.id }).from(enrollment).where(eq(enrollment.prospectId, prospectId)).orderBy(desc(enrollment.createdAt)).limit(1));
  if (!known) return { ok: false, error: "Cette personne n’a été contactée sur aucune séquence." };
  const address = `prospect:${known.id}`;
  await recordOutreach(services.db, workspaceId, { connectionId: null, channel, address, enrollmentId: known.id, at: now });
  await recordSignals(services.db, workspaceId, null, [{ type: "replied", channel, externalId: `hand:${crypto.randomUUID()}`, address, at: now, detail: text.trim() || "Réponse notée par un membre" }]);
  return { ok: true, said: "Noté : la séquence s’arrête pour cette personne et son entreprise." };
}

/** Writes back from the mailbox the conversation started in, in the same thread, with the same way out. */
export async function replyToProspect(services: Services, workspaceId: string, prospectId: string, text: { subject?: string; body: string }): Promise<Tried> {
  if (!text.body.trim()) return { ok: false, error: "Ce message est vide." };
  const sender = senderOf(await settingsOf(services.db, workspaceId));
  if (!sender) return { ok: false, error: "Indiquez dans les Réglages le nom et l’adresse de l’expéditeur." };
  const context = await replyContext(services.db, workspaceId, prospectId);
  if (!context) return { ok: false, error: "Rien n’a encore été envoyé à cette personne par email." };
  if (isSuppressed(context.address, context.suppressed)) return { ok: false, error: "Cette personne a demandé à ne plus être contactée." };
  const opened = context.mailboxId ? await openConnection(services, workspaceId, context.mailboxId) : null;
  if (!opened?.client.sendEmail) return { ok: false, error: "La boîte de cette conversation n’est plus connectée." };
  const url = unsubscribeUrl(services.settings, workspaceId, context.address);
  const body = `${text.body}\n\n${emailFooter(sender, { source: context.source, company: context.company }, url)}`;
  try {
    const sent = await opened.client.sendEmail({ to: context.address, subject: text.subject?.trim() || context.subject, text: body, headers: { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }, inReplyTo: context.references.at(-1), references: context.references });
    const now = services.now();
    await recordOutreach(services.db, workspaceId, { connectionId: opened.row.id, channel: "email", address: context.address, messageId: sent.messageId, externalId: sent.externalId, enrollmentId: context.enrollmentId, at: now });
    await withWorkspace(services.db, workspaceId, (tx) => tx.insert(stepMessage).values({ enrollmentId: context.enrollmentId, channel: "email", subject: text.subject?.trim() || context.subject, body: text.body, writtenBy: "member", status: "sent", connectionId: opened.row.id, externalId: sent.externalId, messageId: sent.messageId ?? null, sentAt: now }));
    return { ok: true, said: "Réponse envoyée." };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "L’envoi a échoué." };
  }
}

async function replyContext(db: Database, workspaceId: string, prospectId: string) {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [row] = await tx
      .select({ enrollmentId: enrollment.id, mailboxId: enrollment.mailboxId, personId: enrollment.personId, company: company.name, source: person.source })
      .from(enrollment)
      .innerJoin(person, eq(person.id, enrollment.personId))
      .innerJoin(company, eq(company.id, enrollment.companyId))
      .innerJoin(sequence, eq(sequence.id, enrollment.sequenceId))
      .where(and(eq(enrollment.prospectId, prospectId), sql`${enrollment.mailboxId} is not null`))
      .orderBy(desc(enrollment.createdAt))
      .limit(1);
    if (!row) return null;
    const thread = await tx
      .select({ messageId: stepMessage.messageId, subject: stepMessage.subject })
      .from(stepMessage)
      .where(and(eq(stepMessage.enrollmentId, row.enrollmentId), eq(stepMessage.channel, "email"), eq(stepMessage.status, "sent")))
      .orderBy(asc(stepMessage.sentAt));
    const [address] = await tx.select({ value: outreach.address }).from(outreach).where(and(eq(outreach.enrollmentId, row.enrollmentId), eq(outreach.channel, "email")));
    if (!address || thread.length === 0) return null;
    const subject = thread[0].subject ?? "Votre message";
    return { ...row, address: address.value, subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`, references: thread.flatMap((item) => (item.messageId ? [item.messageId] : [])), suppressed: await suppressedIn(tx) };
  });
}

/** Someone agreed to WhatsApp messages, or took it back: only those who agreed get them through the Business API. */
export async function recordWhatsappConsent(db: Database, workspaceId: string, prospectId: string, agreed: boolean, now: Date): Promise<boolean> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [row] = await tx.select({ personId: prospect.personId }).from(prospect).where(eq(prospect.id, prospectId));
    if (!row) return false;
    await tx.update(person).set({ whatsappConsentAt: agreed ? now : null }).where(eq(person.id, row.personId));
    return true;
  });
}
