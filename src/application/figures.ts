import { count, eq, gte, sql, type AnyColumn } from "drizzle-orm";
import { outreach, signal } from "@/infrastructure/db/schema/connections";
import { prospect, prospectList } from "@/infrastructure/db/schema/prospects";
import { enrollment, sequence, sequenceStep, stepMessage } from "@/infrastructure/db/schema/sequences";
import { withWorkspace } from "@/infrastructure/db/tenant";
import type { Database } from "@/infrastructure/db/client";

export interface Figures {
  since: string;
  /** Prospects by list and by where they are with it. */
  prospects: { list: string; state: string; count: number }[];
  /** What the workspace sent, by day and channel. */
  sent: { day: string; channel: string; count: number }[];
  /** What came back, by day, channel and kind: replies, bounces, STOPs, outcomes, meetings, sign-ups. */
  signals: { day: string; channel: string; type: string; count: number }[];
  /** Each sequence's steps: how many went, were skipped, or wait for someone. */
  steps: { sequence: string; position: number; channel: string; status: string; count: number }[];
  /** Why people left each sequence, and how many are still on it. */
  people: { sequence: string; status: string; reason: string | null; count: number }[];
  /** What replies came to, as read: interested, not now, not interested, wrong person. */
  interest: { interest: string; count: number }[];
}

/** A moment's day in France: a campaign's figures follow the day its members live. */
const parisDay = (column: AnyColumn) => sql<string>`to_char(${column} at time zone 'Europe/Paris', 'YYYY-MM-DD')`;

/**
 * The workspace's figures since a date, the shape another app reads to measure each prospecting
 * stage (prospects found, emails sent, replies, sign-ups). Counts only: no names, no addresses.
 */
export async function figuresOf(db: Database, workspaceId: string, since: Date): Promise<Figures> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const prospects = await tx
      .select({ list: prospectList.name, state: prospect.state, count: count() })
      .from(prospect)
      .innerJoin(prospectList, eq(prospectList.id, prospect.listId))
      .groupBy(prospectList.name, prospect.state)
      .orderBy(prospectList.name, prospect.state);
    const sentDay = parisDay(outreach.sentAt);
    const sent = await tx.select({ day: sentDay, channel: outreach.channel, count: count() }).from(outreach).where(gte(outreach.sentAt, since)).groupBy(sentDay, outreach.channel).orderBy(sentDay);
    const day = parisDay(signal.at);
    const signals = await tx
      .select({ day, channel: signal.channel, type: signal.type, count: count() })
      .from(signal)
      .where(gte(signal.at, since))
      .groupBy(day, signal.channel, signal.type)
      .orderBy(day);
    const steps = await tx
      .select({ sequence: sequence.name, position: sequenceStep.position, channel: sequenceStep.channel, status: stepMessage.status, count: count() })
      .from(stepMessage)
      .innerJoin(sequenceStep, eq(sequenceStep.id, stepMessage.stepId))
      .innerJoin(sequence, eq(sequence.id, sequenceStep.sequenceId))
      .where(sql`coalesce(${stepMessage.sentAt}, ${stepMessage.createdAt}) >= ${since.toISOString()}::timestamptz`)
      .groupBy(sequence.name, sequenceStep.position, sequenceStep.channel, stepMessage.status)
      .orderBy(sequence.name, sequenceStep.position);
    const people = await tx
      .select({ sequence: sequence.name, status: enrollment.status, reason: enrollment.stopReason, count: count() })
      .from(enrollment)
      .innerJoin(sequence, eq(sequence.id, enrollment.sequenceId))
      .groupBy(sequence.name, enrollment.status, enrollment.stopReason)
      .orderBy(sequence.name);
    const interest = await tx
      .select({ interest: prospect.interest, count: count() })
      .from(prospect)
      .where(sql`${prospect.interest} is not null`)
      .groupBy(prospect.interest);
    return { since: since.toISOString(), prospects, sent, signals, steps, people, interest: interest.map((row) => ({ interest: row.interest as string, count: row.count })) };
  });
}
