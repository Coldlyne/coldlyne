import { and, asc, eq, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { dueAfter, isSuppressed, nextStep, type StepOutcome } from "@/domain/sequences";
import type { Database } from "@/infrastructure/db/client";
import { outreach } from "@/infrastructure/db/schema/connections";
import { company, contactDetail, person, prospect, suppression } from "@/infrastructure/db/schema/prospects";
import { enrollment, sequence, sequenceStep, stepMessage } from "@/infrastructure/db/schema/sequences";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { scheduledWorkChanged } from "@/infrastructure/scheduling/scheduled-work";
import type { Signal } from "./ports";

export interface Enrolled {
  enrolled: number;
  /** People left out, with why. */
  skipped: { prospectId: string; name: string; why: string }[];
}

const NOT_AGAIN = new Set(["replied", "bounced", "opted_out"]);

/**
 * Puts prospects on a sequence. Left out: a company that refused commercial use of its data, an
 * address on the suppression list, someone who already answered, and anyone already on a running
 * sequence: two sequences must not write to the same person at once.
 */
export async function enroll(db: Database, workspaceId: string, sequenceId: string, prospectIds: readonly string[], now: Date): Promise<Enrolled | null> {
  let reopened = false;
  const result = await withWorkspace(db, workspaceId, async (tx) => {
    const [target] = await tx.select({ status: sequence.status }).from(sequence).where(eq(sequence.id, sequenceId));
    if (!target) return null;
    const started = target.status === "running" || target.status === "finished";
    const added: Enrolled = { enrolled: 0, skipped: [] };
    const suppressed = await suppressedIn(tx);
    for (const candidate of await candidatesOf(tx, prospectIds)) {
      const why = await refusalOf(tx, sequenceId, candidate, suppressed);
      if (why) {
        added.skipped.push({ prospectId: candidate.prospectId, name: candidate.name, why });
        continue;
      }
      await tx.insert(enrollment).values({ sequenceId, prospectId: candidate.prospectId, personId: candidate.personId, companyId: candidate.companyId, nextDueAt: started ? now : null });
      await tx.update(prospect).set({ state: "in_sequence" }).where(eq(prospect.id, candidate.prospectId));
      added.enrolled += 1;
    }
    // A finished sequence someone joins is running again: it had only stopped for lack of people.
    if (target.status === "finished" && added.enrolled > 0) {
      await tx.update(sequence).set({ status: "running" }).where(eq(sequence.id, sequenceId));
      reopened = true;
    }
    return added;
  });
  if (reopened) scheduledWorkChanged();
  return result;
}

async function candidatesOf(tx: Database, prospectIds: readonly string[]) {
  if (prospectIds.length === 0) return [];
  return tx
    .select({
      prospectId: prospect.id,
      personId: person.id,
      companyId: company.id,
      state: prospect.state,
      registryOptOut: company.registryOptOut,
      name: sql<string>`trim(coalesce(${person.firstName}, '') || ' ' || ${person.lastName})`,
    })
    .from(prospect)
    .innerJoin(person, eq(person.id, prospect.personId))
    .innerJoin(company, eq(company.id, person.companyId))
    .where(inArray(prospect.id, [...prospectIds]));
}

export async function suppressedIn(tx: Database): Promise<Set<string>> {
  return new Set((await tx.select({ value: suppression.value }).from(suppression)).map((row) => row.value));
}

async function refusalOf(tx: Database, sequenceId: string, candidate: Awaited<ReturnType<typeof candidatesOf>>[number], suppressed: ReadonlySet<string>): Promise<string | null> {
  if (candidate.registryOptOut) return "Cette entreprise refuse l’usage commercial de ses données.";
  if (NOT_AGAIN.has(candidate.state)) return "Cette personne a déjà répondu, refusé d’être contactée, ou son adresse est refusée.";
  const details = await tx.select({ value: contactDetail.value }).from(contactDetail).where(eq(contactDetail.personId, candidate.personId));
  if (details.some(({ value }) => isSuppressed(value, suppressed))) return "Cette personne est sur la liste d’exclusion.";
  const [busy] = await tx
    .select({ sequenceId: enrollment.sequenceId })
    .from(enrollment)
    .where(and(eq(enrollment.personId, candidate.personId), inArray(enrollment.status, ["active", "waiting_member"])));
  if (busy) return busy.sequenceId === sequenceId ? "Cette personne est déjà sur cette séquence." : "Cette personne est déjà sur une autre séquence en cours.";
  const [done] = await tx
    .select({ id: enrollment.id })
    .from(enrollment)
    .where(and(eq(enrollment.sequenceId, sequenceId), eq(enrollment.prospectId, candidate.prospectId)));
  if (done) return "Cette personne a déjà suivi cette séquence.";
  const [spoke] = await tx
    .select({ id: prospect.id })
    .from(prospect)
    .innerJoin(person, eq(person.id, prospect.personId))
    .where(and(eq(person.companyId, candidate.companyId), inArray(prospect.state, ["replied", "opted_out"])));
  return spoke ? "Quelqu’un de cette entreprise a déjà répondu ou refusé d’être contacté." : null;
}

/** What hasn't left yet comes to nothing when someone stops: a reply must cancel the next message, not race it. */
async function cancelPending(tx: Database, enrollmentIds: readonly string[], note: string) {
  if (enrollmentIds.length === 0) return;
  await tx
    .update(stepMessage)
    .set({ status: "skipped", note })
    .where(and(inArray(stepMessage.enrollmentId, [...enrollmentIds]), inArray(stepMessage.status, ["draft", "awaiting_approval", "approved", "to_do"])));
}

const STOP_NOTES: Record<string, string> = {
  replied: "Annulé : cette personne a répondu.",
  colleague_replied: "Annulé : quelqu’un de la même entreprise a répondu.",
  opted_out: "Annulé : cette personne ne veut plus être contactée.",
  bounced: "Annulé : l’adresse est refusée.",
  suppressed: "Annulé : l’adresse est sur la liste d’exclusion.",
  member: "Retiré par un membre.",
};

/** Stops these people on their sequences, and everything that was about to go out to them. */
export async function stopEnrollments(tx: Database, enrollmentIds: readonly string[], reason: string): Promise<void> {
  if (enrollmentIds.length === 0) return;
  await tx
    .update(enrollment)
    .set({ status: "stopped", stopReason: reason, nextDueAt: null })
    .where(and(inArray(enrollment.id, [...enrollmentIds]), inArray(enrollment.status, ["active", "waiting_member"])));
  await cancelPending(tx, enrollmentIds, STOP_NOTES[reason] ?? "Annulé.");
}

/** A member takes someone off a sequence. */
export async function removeFromSequence(db: Database, workspaceId: string, enrollmentId: string): Promise<void> {
  await withWorkspace(db, workspaceId, (tx) => stopEnrollments(tx, [enrollmentId], "member"));
}

const running = inArray(enrollment.status, ["active", "waiting_member"]);

/**
 * Someone answered, or asked to stop: all their sequences end, and so do those of anyone else at
 * the same company. A company that just spoke to one of you shouldn't get a follow-up to another.
 */
async function stopPersonAndCompany(tx: Database, personId: string, companyId: string, reason: "replied" | "opted_out"): Promise<void> {
  const theirs = await tx.select({ id: enrollment.id }).from(enrollment).where(and(eq(enrollment.personId, personId), running));
  await stopEnrollments(tx, theirs.map((row) => row.id), reason);
  // A reply often comes after the last step: the sequence it answers still counts it.
  await tx
    .update(enrollment)
    .set({ stopReason: reason })
    .where(and(eq(enrollment.personId, personId), eq(enrollment.status, "finished"), isNull(enrollment.stopReason)));
  const colleagues = await tx
    .select({ id: enrollment.id })
    .from(enrollment)
    .where(and(eq(enrollment.companyId, companyId), ne(enrollment.personId, personId), running));
  await stopEnrollments(tx, colleagues.map((row) => row.id), "colleague_replied");
  await tx
    .update(prospect)
    .set({ state: reason })
    .where(eq(prospect.personId, personId));
  const colleagueProspects = colleagues.length ? await tx.select({ id: enrollment.prospectId }).from(enrollment).where(inArray(enrollment.id, colleagues.map((row) => row.id))) : [];
  if (colleagueProspects.length) {
    await tx
      .update(prospect)
      .set({ state: "done" })
      .where(inArray(prospect.id, colleagueProspects.map((row) => row.id)));
  }
}

async function stepsOf(tx: Database, sequenceId: string) {
  return tx.select({ position: sequenceStep.position, condition: sequenceStep.condition, waitDays: sequenceStep.waitDays }).from(sequenceStep).where(eq(sequenceStep.sequenceId, sequenceId)).orderBy(asc(sequenceStep.position));
}

/** A step ended this way: on to the next one that applies, or the end of the sequence for this person. */
export async function advance(tx: Database, enrollmentId: string, position: number, outcome: StepOutcome, at: Date): Promise<void> {
  const [row] = await tx.select({ sequenceId: enrollment.sequenceId, prospectId: enrollment.prospectId }).from(enrollment).where(eq(enrollment.id, enrollmentId));
  if (!row) return;
  const next = nextStep(await stepsOf(tx, row.sequenceId), position, outcome);
  if (next) {
    await tx.update(enrollment).set({ status: "active", lastPosition: position, lastOutcome: outcome, nextDueAt: dueAfter(at, next.waitDays) }).where(eq(enrollment.id, enrollmentId));
    return;
  }
  await tx.update(enrollment).set({ status: "finished", lastPosition: position, lastOutcome: outcome, nextDueAt: null }).where(eq(enrollment.id, enrollmentId));
  await tx.update(prospect).set({ state: "done" }).where(eq(prospect.id, row.prospectId));
}

/** An address that can't be reached: on to a step written for that if there is one, otherwise the end. */
export async function bounce(tx: Database, row: { id: string; sequenceId: string; prospectId: string; lastPosition: number }, at: Date): Promise<void> {
  const next = nextStep(await stepsOf(tx, row.sequenceId), row.lastPosition, "bounced");
  if (next) {
    await tx.update(enrollment).set({ status: "active", lastOutcome: "bounced", nextDueAt: dueAfter(at, next.waitDays) }).where(eq(enrollment.id, row.id));
    return;
  }
  await stopEnrollments(tx, [row.id], "bounced");
  await tx.update(prospect).set({ state: "bounced" }).where(eq(prospect.id, row.prospectId));
}

interface Concerned {
  id: string;
  sequenceId: string;
  prospectId: string;
  personId: string;
  companyId: string;
  lastPosition: number;
}

/** The sequences a signal is about: by the message it answers, by who was written to, or by who holds that address. */
async function enrollmentsConcernedBy(tx: Database, found: Signal): Promise<Concerned[]> {
  const fields = { id: enrollment.id, sequenceId: enrollment.sequenceId, prospectId: enrollment.prospectId, personId: enrollment.personId, companyId: enrollment.companyId, lastPosition: enrollment.lastPosition };
  const written = or(found.address ? eq(outreach.address, found.address) : undefined, found.inReplyTo ? eq(outreach.messageId, found.inReplyTo) : undefined);
  if (!written) return [];
  const viaOutreach = await tx.selectDistinct(fields).from(outreach).innerJoin(enrollment, eq(enrollment.id, outreach.enrollmentId)).where(written);
  if (viaOutreach.length || !found.address) return viaOutreach;
  return tx.selectDistinct(fields).from(contactDetail).innerJoin(enrollment, eq(enrollment.personId, contactDetail.personId)).where(eq(contactDetail.value, found.address));
}

/** The call task a provider's report answers: by the call's id, or by the number where the provider gives no id (Aircall). */
async function openCallTask(tx: Database, found: Signal) {
  const position = sql<number | null>`(select ${sequenceStep.position} from ${sequenceStep} where ${sequenceStep.id} = ${stepMessage.stepId})`;
  const fields = { id: stepMessage.id, enrollmentId: stepMessage.enrollmentId, position };
  const [byId] = await tx.select(fields).from(stepMessage).where(and(eq(stepMessage.externalId, found.externalId), eq(stepMessage.status, "to_do")));
  if (byId || !found.address) return byId;
  const [byNumber] = await tx
    .select(fields)
    .from(stepMessage)
    .innerJoin(enrollment, eq(enrollment.id, stepMessage.enrollmentId))
    .innerJoin(contactDetail, eq(contactDetail.personId, enrollment.personId))
    .where(and(eq(contactDetail.value, found.address), inArray(stepMessage.channel, ["call", "voicemail"]), eq(stepMessage.status, "to_do")));
  return byNumber;
}

/** What a call's outcome, reported by the provider, does to the task it answers. */
async function completeCallTask(tx: Database, found: Signal, outcome: StepOutcome): Promise<void> {
  const task = await openCallTask(tx, found);
  if (!task) return;
  await tx.update(stepMessage).set({ status: "done", outcome, sentAt: found.at }).where(eq(stepMessage.id, task.id));
  if (task.position !== null) await advance(tx, task.enrollmentId, task.position, outcome, found.at);
}

const CALL_OUTCOMES: Partial<Record<Signal["type"], StepOutcome>> = { answered: "answered", no_answer: "no_answer", voicemail_left: "voicemail_left" };

/**
 * What came back changes what goes out next. Called in the transaction that records the signals, so
 * a reply and the stop it causes can't be separated. An auto-reply stops nothing: the person hasn't answered.
 */
export async function reactToSignals(tx: Database, signals: readonly Signal[]): Promise<void> {
  for (const found of signals) {
    const outcome = CALL_OUTCOMES[found.type];
    if (outcome) await completeCallTask(tx, found, outcome);
    if (found.type === "auto_reply" || outcome) continue;
    const concerned = await enrollmentsConcernedBy(tx, found);
    for (const row of concerned) {
      if (found.type === "bounced") await bounce(tx, row, found.at);
      if (found.type === "opted_out") await stopPersonAndCompany(tx, row.personId, row.companyId, "opted_out");
      if (found.type === "replied" || found.type === "meeting_booked" || found.type === "signed_up") await stopPersonAndCompany(tx, row.personId, row.companyId, "replied");
    }
  }
}

/** Everyone waiting for a step whose time has come, on running sequences, the longest waiting first. */
export async function dueEnrollments(tx: Database, now: Date, limit = 300) {
  return tx
    .select({
      id: enrollment.id,
      sequenceId: enrollment.sequenceId,
      prospectId: enrollment.prospectId,
      personId: enrollment.personId,
      companyId: enrollment.companyId,
      lastPosition: enrollment.lastPosition,
      lastOutcome: enrollment.lastOutcome,
      mailboxId: enrollment.mailboxId,
    })
    .from(enrollment)
    .innerJoin(sequence, eq(sequence.id, enrollment.sequenceId))
    .where(and(eq(sequence.status, "running"), eq(enrollment.status, "active"), sql`${enrollment.nextDueAt} <= ${now.toISOString()}::timestamptz`))
    .orderBy(asc(enrollment.nextDueAt))
    .limit(limit);
}

export type DueEnrollment = Awaited<ReturnType<typeof dueEnrollments>>[number];

/** Launching starts everyone who was waiting for it. */
export async function startWaiting(tx: Database, sequenceId: string, now: Date): Promise<void> {
  await tx
    .update(enrollment)
    .set({ nextDueAt: now })
    .where(and(eq(enrollment.sequenceId, sequenceId), eq(enrollment.status, "active"), isNull(enrollment.nextDueAt)));
}

/** A step was removed: whoever waited on its task moves on. */
export async function releaseFromStep(tx: Database, stepId: string, position: number, now: Date): Promise<void> {
  const held = await tx
    .select({ enrollmentId: stepMessage.enrollmentId })
    .from(stepMessage)
    .where(and(eq(stepMessage.stepId, stepId), notInArray(stepMessage.status, ["sent", "done", "skipped", "failed"])));
  for (const { enrollmentId } of held) await advance(tx, enrollmentId, position, "done", now);
}
