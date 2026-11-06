import { and, asc, eq, inArray, isNull, ne, notInArray, or, sql, type AnyColumn } from "drizzle-orm";
import type { ElsewhereNote } from "@/domain/directory";
import { dueAfter, isSuppressed, nextStep, type OffLimits, type StepOutcome } from "@/domain/sequences";
import type { Database } from "@/infrastructure/db/client";
import { outreach } from "@/infrastructure/db/schema/connections";
import { company, contactDetail, person, prospect, suppression } from "@/infrastructure/db/schema/prospects";
import { enrollment, sequence, sequenceStep, stepMessage } from "@/infrastructure/db/schema/sequences";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { scheduledWorkChanged } from "@/infrastructure/scheduling/scheduled-work";
import { elsewhereAmong } from "./directory";
import type { Signal } from "./ports";

export interface Enrolled {
  enrolled: number;
  /** People left out, with why. */
  skipped: { prospectId: string; name: string; why: string }[];
  /** Those just added that another workspace of the directory wrote to, or who opted out of it: nothing stops them, a member decides. */
  elsewhere?: ElsewhereNote[];
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
    const enrolledPeople: string[] = [];
    for (const candidate of await candidatesOf(tx, prospectIds)) {
      const why = await refusalOf(tx, sequenceId, candidate, suppressed);
      if (why) {
        added.skipped.push({ prospectId: candidate.prospectId, name: candidate.name, why });
        continue;
      }
      await tx.insert(enrollment).values({ sequenceId, prospectId: candidate.prospectId, personId: candidate.personId, companyId: candidate.companyId, nextDueAt: started ? now : null });
      await tx.update(prospect).set({ state: "in_sequence" }).where(eq(prospect.id, candidate.prospectId));
      added.enrolled += 1;
      enrolledPeople.push(candidate.personId);
    }
    // A finished sequence someone joins is running again: it had only stopped for lack of people.
    if (target.status === "finished" && added.enrolled > 0) {
      await tx.update(sequence).set({ status: "running" }).where(eq(sequence.id, sequenceId));
      reopened = true;
    }
    const elsewhere = await elsewhereAmong(tx, enrolledPeople);
    return elsewhere.length ? { ...added, elsewhere } : added;
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

/**
 * Puts these on the workspace's list. Someone asking, or an address bouncing, says more than the
 * workspace's own exclusion of them, which it replaces: what the directory's other workspaces are told
 * goes by why. Whichever came first, nothing else ever comes off.
 */
export async function addToSuppressionList(tx: Database, entries: readonly { value: string; reason: "opted_out" | "bounced" | "asked" | "member" }[]): Promise<void> {
  const distinct = [...new Map(entries.map((entry) => [entry.value, entry])).values()];
  if (distinct.length === 0) return;
  await tx
    .insert(suppression)
    .values(distinct)
    .onConflictDoUpdate({ target: [suppression.workspaceId, suppression.value], set: { reason: sql`excluded.reason` }, where: sql`${suppression.reason} = 'member' and excluded.reason <> 'member'` });
}

/** A row of this workspace's own list, rather than a bounce another workspace of its group let it read. */
export const ownSuppression = sql`${suppression.workspaceId} = app_workspace_id()`;

/** What this workspace can't write to: its own list, and the addresses that bounced for another workspace of its group. Row-level security decides which it reads. */
export async function suppressedIn(tx: Database): Promise<OffLimits> {
  const rows = await tx.select({ value: suppression.value, reason: suppression.reason, own: sql<boolean>`${ownSuppression}` }).from(suppression);
  const among = (keep: (row: (typeof rows)[number]) => boolean) => new Set(rows.filter(keep).map(({ value }) => value));
  return { refused: among(({ own, reason }) => own && reason !== "bounced"), bouncedHere: among(({ own, reason }) => own && reason === "bounced"), bouncedElsewhere: among(({ own }) => !own) };
}

async function refusalOf(tx: Database, sequenceId: string, candidate: Awaited<ReturnType<typeof candidatesOf>>[number], suppressed: OffLimits): Promise<string | null> {
  if (candidate.registryOptOut) return "Cette entreprise refuse l’usage commercial de ses données.";
  if (NOT_AGAIN.has(candidate.state)) return "Cette personne a déjà répondu, refusé d’être contactée, ou son adresse est refusée.";
  const details = await tx.select({ value: contactDetail.value }).from(contactDetail).where(eq(contactDetail.personId, candidate.personId));
  // This workspace's own list, for any of their details. What bounced for another workspace only rules that address out.
  if (details.some(({ value }) => isSuppressed(value, suppressed.refused) || isSuppressed(value, suppressed.bouncedHere))) return "Cette personne est sur la liste d’exclusion.";
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
  registry_opt_out: "Annulé : cette entreprise refuse l’usage commercial de ses données.",
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

/** Whether this column holds the address, or an address at the domain: what `isSuppressed` matches. */
const heldAt = (column: AnyColumn, value: string) => or(eq(column, value), sql`split_part(${column}, '@', 2) = ${value}`);

/** Everyone on a sequence at this address or domain, by what the workspace knows of them and by what it wrote to. */
async function enrollmentsAt(tx: Database, value: string) {
  const fields = { id: enrollment.id, personId: enrollment.personId, companyId: enrollment.companyId };
  const byDetail = await tx.selectDistinct(fields).from(enrollment).innerJoin(contactDetail, eq(contactDetail.personId, enrollment.personId)).where(heldAt(contactDetail.value, value));
  const byOutreach = await tx.selectDistinct(fields).from(enrollment).innerJoin(outreach, eq(outreach.enrollmentId, enrollment.id)).where(heldAt(outreach.address, value));
  return [...byDetail, ...byOutreach];
}

/** A member marked someone as having asked not to be contacted: it does what their STOP would, in this workspace. */
export async function stopEveryoneAt(tx: Database, value: string): Promise<void> {
  const people = new Map((await enrollmentsAt(tx, value)).map((row) => [row.personId, row]));
  for (const { personId, companyId } of people.values()) await stopPersonAndCompany(tx, personId, companyId, "opted_out");
}

/** The workspace excluded someone itself: their sequences stop, with what waits for a member, and nobody else's. */
export async function stopExcludedAt(tx: Database, value: string): Promise<void> {
  await stopEnrollments(tx, (await enrollmentsAt(tx, value)).map(({ id }) => id), "suppressed");
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

/**
 * Everyone waiting for a step whose time has come, on running sequences, each sequence and mailbox in
 * turn, the longest waiting first within each. Those who can't go on for now (a paused mailbox, a closed
 * window) keep their place, so going by age alone they would fill the run and starve everyone behind them.
 */
export async function dueEnrollments(tx: Database, now: Date, limit = 300) {
  const turn = sql`row_number() over (partition by ${enrollment.sequenceId}, ${enrollment.mailboxId} order by ${enrollment.nextDueAt})`;
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
    .orderBy(turn, asc(enrollment.nextDueAt))
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
