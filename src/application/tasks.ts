import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { addressToUse, contactKindOf, type Channel, type OffLimits, type StepOutcome } from "@/domain/sequences";
import type { Database } from "@/infrastructure/db/client";
import { outreach } from "@/infrastructure/db/schema/connections";
import { company, contactDetail, person, prospect } from "@/infrastructure/db/schema/prospects";
import { enrollment, sequence, sequenceStep, stepMessage } from "@/infrastructure/db/schema/sequences";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { openConnection } from "./connections";
import type { Tried } from "./connection-use";
import { ownDetailsFirst } from "./directory";
import { advance, suppressedIn } from "./enrollments";
import type { Services } from "./services";
import { recordOutreach, recordSignals } from "./signals";
import { memberPhoneOf } from "./workspace-settings";

/**
 * A member's list for the day: what only a person may do (a call, a LinkedIn message), prepared by
 * Coldlyne, and what came of it. The sequence waits for them and carries on from their answer.
 */

export const TASK_OUTCOMES = ["done", "answered", "no_answer", "voicemail_left", "replied"] as const;
export type TaskOutcome = (typeof TASK_OUTCOMES)[number];

export interface DayTask {
  id: string;
  channel: Channel;
  subject: string | null;
  text: string | null;
  summary: string | null;
  callId: string | null;
  sequence: string;
  sequenceId: string;
  person: string;
  role: string | null;
  company: string;
  /** Where to do it: a number to call, a profile to open. */
  address: string | null;
  recordingUrl: string | null;
}

/** What's left to do, the oldest first: this member's, or everyone's. */
export async function tasksOf(db: Database, workspaceId: string, userId: string, everyone = false): Promise<DayTask[]> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const rows = await tx
      .select({
        id: stepMessage.id,
        channel: stepMessage.channel,
        subject: stepMessage.subject,
        text: stepMessage.body,
        summary: stepMessage.summary,
        callId: stepMessage.externalId,
        sequence: sequence.name,
        sequenceId: sequence.id,
        enrollmentId: enrollment.id,
        personId: person.id,
        person: sql<string>`trim(coalesce(${person.firstName}, '') || ' ' || ${person.lastName})`,
        role: person.role,
        company: company.name,
        options: sequenceStep.options,
      })
      .from(stepMessage)
      .innerJoin(enrollment, eq(enrollment.id, stepMessage.enrollmentId))
      .innerJoin(sequence, eq(sequence.id, enrollment.sequenceId))
      .innerJoin(prospect, eq(prospect.id, enrollment.prospectId))
      .innerJoin(person, eq(person.id, prospect.personId))
      .innerJoin(company, eq(company.id, person.companyId))
      .leftJoin(sequenceStep, eq(sequenceStep.id, stepMessage.stepId))
      .where(and(eq(stepMessage.status, "to_do"), everyone ? undefined : eq(stepMessage.assignedTo, userId)))
      .orderBy(asc(stepMessage.createdAt))
      .limit(200);
    const addressOn = await addressesFor(tx, rows);
    return rows.map(({ personId, enrollmentId, options, ...row }) => ({
      ...row,
      channel: row.channel as Channel,
      address: addressOn({ personId, enrollmentId }, row.channel as Channel),
      recordingUrl: options?.recordingUrl ?? null,
    }));
  });
}

/** Where to do these tasks: the same address sending would choose, read once for all of them. */
async function addressesFor(tx: Database, tasks: readonly { personId: string; enrollmentId: string }[]) {
  const details = tasks.length ? await tx.select({ personId: contactDetail.personId, kind: contactDetail.kind, value: contactDetail.value }).from(contactDetail).where(inArray(contactDetail.personId, tasks.map(({ personId }) => personId))).orderBy(...ownDetailsFirst) : [];
  const written = tasks.length ? await tx.select({ enrollmentId: outreach.enrollmentId, address: outreach.address }).from(outreach).where(inArray(outreach.enrollmentId, tasks.map(({ enrollmentId }) => enrollmentId))).orderBy(desc(outreach.sentAt)) : [];
  const offLimits: OffLimits = await suppressedIn(tx);
  return ({ personId, enrollmentId }: { personId: string; enrollmentId: string }, channel: Channel) => {
    const used = written.filter((row) => row.enrollmentId === enrollmentId).map(({ address }) => address);
    return addressToUse(details.filter((detail) => detail.personId === personId), contactKindOf(channel), used, offLimits).address?.value ?? null;
  };
}

async function taskRow(db: Database, workspaceId: string, messageId: string) {
  const [row] = await withWorkspace(db, workspaceId, (tx) =>
    tx
      .select({ id: stepMessage.id, status: stepMessage.status, channel: stepMessage.channel, externalId: stepMessage.externalId, enrollmentId: stepMessage.enrollmentId, personId: enrollment.personId, sequenceId: enrollment.sequenceId, position: sequenceStep.position, options: sequenceStep.options, callConnection: sql<string | null>`${sequence.channels}->>'call'` })
      .from(stepMessage)
      .innerJoin(enrollment, eq(enrollment.id, stepMessage.enrollmentId))
      .innerJoin(sequence, eq(sequence.id, enrollment.sequenceId))
      .leftJoin(sequenceStep, eq(sequenceStep.id, stepMessage.stepId))
      .where(eq(stepMessage.id, messageId)),
  );
  return row;
}

async function addressOf(db: Database, workspaceId: string, task: { personId: string; enrollmentId: string }, channel: Channel): Promise<string | null> {
  return withWorkspace(db, workspaceId, async (tx) => (await addressesFor(tx, [task]))(task, channel));
}

/**
 * Says how a task ended. The person answering stops their sequences, on every channel and for their
 * company, like any reply; anything else moves on to the next step that applies.
 */
export async function completeTask(services: Services, workspaceId: string, userId: string, messageId: string, outcome: TaskOutcome, summary?: string): Promise<Tried> {
  const task = await taskRow(services.db, workspaceId, messageId);
  if (!task || task.status !== "to_do") return { ok: false, error: "Cette tâche n’est plus à faire." };
  const now = services.now();
  const channel = task.channel as Channel;
  const address = (await addressOf(services.db, workspaceId, task, channel)) ?? `prospect:${task.enrollmentId}`;
  await recordOutreach(services.db, workspaceId, { connectionId: null, channel, address, enrollmentId: task.enrollmentId, at: now });
  await withWorkspace(services.db, workspaceId, (tx) => tx.update(stepMessage).set({ status: "done", outcome, summary: summary?.trim() || null, doneBy: userId, sentAt: now }).where(eq(stepMessage.id, messageId)));
  if (outcome === "replied") {
    await recordSignals(services.db, workspaceId, null, [{ type: "replied", channel, externalId: `task:${messageId}`, address, at: now, detail: summary?.trim() || "Réponse notée par un membre" }]);
    return { ok: true, said: "Noté : la séquence s’arrête pour cette personne et son entreprise." };
  }
  if (task.position !== null) await withWorkspace(services.db, workspaceId, (tx) => advance(tx, task.enrollmentId, task.position as number, outcome as StepOutcome, now));
  return { ok: true, said: "Noté." };
}

/** Rings the member, then the prospect, through the sequence's telephony connection: a member is always on the line. */
export async function placeTaskCall(services: Services, workspaceId: string, userId: string, messageId: string): Promise<Tried> {
  const task = await taskRow(services.db, workspaceId, messageId);
  if (!task || task.status !== "to_do") return { ok: false, error: "Cette tâche n’est plus à faire." };
  if (!task.callConnection) return { ok: false, error: "Cette séquence n’a pas de téléphonie connectée : appelez depuis votre téléphone." };
  const memberPhone = await memberPhoneOf(services.db, workspaceId, userId);
  if (!memberPhone) return { ok: false, error: "Indiquez votre numéro dans les Réglages : c’est lui qui sonne d’abord." };
  const prospectPhone = await addressOf(services.db, workspaceId, task, "call");
  if (!prospectPhone) return { ok: false, error: "Cette personne n’a pas de numéro." };
  const opened = await openConnection(services, workspaceId, task.callConnection);
  if (!opened?.client.placeCall) return { ok: false, error: "Cette connexion ne passe pas d’appels." };
  try {
    const call = await opened.client.placeCall({ memberPhone, prospectPhone, voicemailUrl: task.options?.recordingUrl, reference: messageId });
    await withWorkspace(services.db, workspaceId, (tx) => tx.update(stepMessage).set({ externalId: call.externalId, connectionId: opened.row.id }).where(eq(stepMessage.id, messageId)));
    await recordOutreach(services.db, workspaceId, { connectionId: opened.row.id, channel: "call", address: prospectPhone, externalId: call.externalId, enrollmentId: task.enrollmentId, at: services.now() });
    return { ok: true, said: "Votre téléphone va sonner." };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "L’appel n’a pas pu partir." };
  }
}

/** The member's one click when their call lands on voicemail: never without that call (article L34-5 CPCE). */
export async function leaveVoicemail(services: Services, workspaceId: string, messageId: string): Promise<Tried> {
  const task = await taskRow(services.db, workspaceId, messageId);
  if (!task?.externalId || !task.callConnection) return { ok: false, error: "Un message ne se dépose que pendant un appel passé depuis Coldlyne." };
  if (!task.options?.recordingUrl) return { ok: false, error: "Cette étape n’a pas de message enregistré." };
  const opened = await openConnection(services, workspaceId, task.callConnection);
  if (!opened?.client.dropVoicemail) return { ok: false, error: "Ce service ne sait pas déposer de message." };
  try {
    await opened.client.dropVoicemail(task.externalId, task.options.recordingUrl);
    return { ok: true, said: "Message déposé." };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Le message n’a pas pu être déposé." };
  }
}
