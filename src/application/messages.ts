import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/infrastructure/db/client";
import { company, person, prospect } from "@/infrastructure/db/schema/prospects";
import { enrollment, sequence, sequenceStep, stepMessage } from "@/infrastructure/db/schema/sequences";
import { withWorkspace } from "@/infrastructure/db/tenant";

/**
 * The words of each step for each person: written ahead by an assistant or a member, approved where
 * the workspace asks for that, corrected when they couldn't go. A message that has left never changes.
 */

const GONE = new Set(["sent", "sending", "done"]);

export type Written = { ok: true; messageId: string } | { ok: false; error: string };

/** Sets what a step says to one person. In a workspace that approves first, new words need a new approval. */
export async function writeMessage(db: Database, workspaceId: string, target: { enrollmentId: string; stepId: string }, text: { subject?: string | null; body: string }, by: "assistant" | "member", now: Date): Promise<Written> {
  if (!text.body.trim()) return { ok: false, error: "Ce message est vide." };
  return withWorkspace(db, workspaceId, async (tx) => {
    const [step] = await tx
      .select({ channel: sequenceStep.channel, subject: sequenceStep.subject })
      .from(sequenceStep)
      .innerJoin(enrollment, eq(enrollment.sequenceId, sequenceStep.sequenceId))
      .where(and(eq(sequenceStep.id, target.stepId), eq(enrollment.id, target.enrollmentId)));
    if (!step) return { ok: false, error: "Cette personne n’est pas sur cette séquence, ou cette étape n’y figure pas." };
    const [existing] = await tx.select({ id: stepMessage.id, status: stepMessage.status }).from(stepMessage).where(and(eq(stepMessage.enrollmentId, target.enrollmentId), eq(stepMessage.stepId, target.stepId)));
    if (existing && GONE.has(existing.status)) return { ok: false, error: "Ce message est déjà parti." };
    const status: "awaiting_approval" | "to_do" | "draft" = existing?.status === "awaiting_approval" || existing?.status === "approved" ? "awaiting_approval" : existing?.status === "to_do" ? "to_do" : "draft";
    const values = { subject: text.subject === undefined ? step.subject : text.subject, body: text.body, writtenBy: by, status, note: null };
    const [row] = await tx
      .insert(stepMessage)
      .values({ ...target, channel: step.channel, ...values })
      .onConflictDoUpdate({ target: [stepMessage.enrollmentId, stepMessage.stepId], set: values })
      .returning({ id: stepMessage.id });
    // One that failed for lack of a field goes back in line now that it has its words.
    if (existing?.status === "failed") await tx.update(enrollment).set({ status: "active", nextDueAt: now }).where(eq(enrollment.id, target.enrollmentId));
    return { ok: true, messageId: row.id };
  });
}

export interface MessageForReview {
  id: string;
  enrollmentId: string;
  stepId: string | null;
  sequenceId: string;
  sequence: string;
  channel: string;
  subject: string | null;
  body: string | null;
  note: string | null;
  writtenBy: string;
  person: string;
  company: string;
}

/** Messages waiting for a member: to approve, or to correct. */
export async function messagesToReview(db: Database, workspaceId: string, status: "awaiting_approval" | "failed", sequenceId?: string): Promise<MessageForReview[]> {
  return withWorkspace(db, workspaceId, (tx) =>
    tx
      .select({
        id: stepMessage.id,
        enrollmentId: stepMessage.enrollmentId,
        stepId: stepMessage.stepId,
        sequenceId: enrollment.sequenceId,
        sequence: sequence.name,
        channel: stepMessage.channel,
        subject: stepMessage.subject,
        body: stepMessage.body,
        note: stepMessage.note,
        writtenBy: stepMessage.writtenBy,
        person: sql<string>`trim(coalesce(${person.firstName}, '') || ' ' || ${person.lastName})`,
        company: company.name,
      })
      .from(stepMessage)
      .innerJoin(enrollment, eq(enrollment.id, stepMessage.enrollmentId))
      .innerJoin(sequence, eq(sequence.id, enrollment.sequenceId))
      .innerJoin(prospect, eq(prospect.id, enrollment.prospectId))
      .innerJoin(person, eq(person.id, prospect.personId))
      .innerJoin(company, eq(company.id, person.companyId))
      .where(and(eq(stepMessage.status, status), sequenceId ? eq(enrollment.sequenceId, sequenceId) : undefined))
      .orderBy(asc(stepMessage.createdAt))
      .limit(200),
  );
}

/** Approves messages, which go at the next run within their window and caps. Returns how many were waiting. */
export async function approveMessages(db: Database, workspaceId: string, userId: string, messageIds: readonly string[], now: Date): Promise<number> {
  if (messageIds.length === 0) return 0;
  return withWorkspace(db, workspaceId, async (tx) => {
    const approved = await tx
      .update(stepMessage)
      .set({ status: "approved", approvedBy: userId })
      .where(and(inArray(stepMessage.id, [...messageIds]), eq(stepMessage.status, "awaiting_approval")))
      .returning({ enrollmentId: stepMessage.enrollmentId });
    if (approved.length) await tx.update(enrollment).set({ status: "active", nextDueAt: now }).where(inArray(enrollment.id, approved.map((row) => row.enrollmentId)));
    return approved.length;
  });
}

/** Tries a failed message again, as it stands. */
export async function retryMessage(db: Database, workspaceId: string, messageId: string, now: Date): Promise<boolean> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [row] = await tx
      .update(stepMessage)
      .set({ status: "draft", note: null, attempts: 0 })
      .where(and(eq(stepMessage.id, messageId), eq(stepMessage.status, "failed")))
      .returning({ enrollmentId: stepMessage.enrollmentId });
    if (!row) return false;
    await tx.update(enrollment).set({ status: "active", nextDueAt: now }).where(eq(enrollment.id, row.enrollmentId));
    return true;
  });
}
