import { count, desc, eq, gte, or, sql, type AnyColumn } from "drizzle-orm";
import { outreach, signal } from "@/infrastructure/db/schema/connections";
import { prospect, prospectList } from "@/infrastructure/db/schema/prospects";
import { enrollment, sequence, sequenceStep, stepMessage } from "@/infrastructure/db/schema/sequences";
import { workspace } from "@/infrastructure/db/schema/tenancy";
import { withWorkspace } from "@/infrastructure/db/tenant";
import type { Database } from "@/infrastructure/db/client";

/** Per day, what another app needs to measure each stage of a campaign, as far as each can be told apart. */
export interface DailyFigures {
  /** People added to each list. */
  prospects: { day: string; list: string; count: number }[];
  /** What each sequence's steps sent or had done. Tests and replies by hand aren't on a sequence, so they aren't here. */
  sent: { day: string; sequence: string; channel: string; count: number }[];
  /** What came back. Its sequence is the one last written from to that address, or that sent the message it answers; none when no sequence did. */
  signals: { day: string; sequence: string | null; channel: string; type: string; count: number }[];
  /** What replies came to, by the day the prospect last changed: that is when it was read, as little else changes someone who replied. Its sequence is the last they joined. */
  interest: { day: string; sequence: string | null; interest: string; count: number }[];
}

export interface Figures {
  /** Whose figures these are: what an app holding a key can name them by. */
  workspace: { id: string; name: string };
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
  daily: DailyFigures;
}

/** A moment's day in France: a campaign's figures follow the day its members live. */
const parisDay = (column: AnyColumn) => sql<string>`to_char(${column} at time zone 'Europe/Paris', 'YYYY-MM-DD')`;

function prospectsAddedByDay(tx: Database, since: Date) {
  const day = parisDay(prospect.createdAt);
  return tx
    .select({ day, list: prospectList.name, count: count() })
    .from(prospect)
    .innerJoin(prospectList, eq(prospectList.id, prospect.listId))
    .where(gte(prospect.createdAt, since))
    .groupBy(day, prospectList.name)
    .orderBy(day, prospectList.name);
}

function sentBySequence(tx: Database, since: Date) {
  const day = parisDay(outreach.sentAt);
  return tx
    .select({ day, sequence: sequence.name, channel: outreach.channel, count: count() })
    .from(outreach)
    .innerJoin(enrollment, eq(enrollment.id, outreach.enrollmentId))
    .innerJoin(sequence, eq(sequence.id, enrollment.sequenceId))
    .where(gte(outreach.sentAt, since))
    .groupBy(day, sequence.name, outreach.channel)
    .orderBy(day, sequence.name);
}

/** Each signal counts once, for one sequence, so adding the sequences up gives the whole workspace. */
function signalsBySequence(tx: Database, since: Date) {
  const day = parisDay(signal.at);
  const writtenFrom = tx
    .select({ name: sequence.name })
    .from(outreach)
    .innerJoin(enrollment, eq(enrollment.id, outreach.enrollmentId))
    .innerJoin(sequence, eq(sequence.id, enrollment.sequenceId))
    .where(or(eq(outreach.messageId, signal.inReplyTo), eq(outreach.address, signal.address)))
    .orderBy(sql`(${outreach.messageId} = ${signal.inReplyTo}) desc nulls last`, desc(outreach.sentAt))
    .limit(1)
    .as("written_from");
  return tx
    .select({ day, sequence: writtenFrom.name, channel: signal.channel, type: signal.type, count: count() })
    .from(signal)
    .leftJoinLateral(writtenFrom, sql`true`)
    .where(gte(signal.at, since))
    .groupBy(day, writtenFrom.name, signal.channel, signal.type)
    .orderBy(day);
}

/** Each prospect counts once, for one sequence, for the same reason. */
async function interestBySequence(tx: Database, since: Date) {
  const day = parisDay(prospect.updatedAt);
  const lastJoined = tx
    .select({ name: sequence.name })
    .from(enrollment)
    .innerJoin(sequence, eq(sequence.id, enrollment.sequenceId))
    .where(eq(enrollment.prospectId, prospect.id))
    .orderBy(desc(enrollment.createdAt))
    .limit(1)
    .as("last_joined");
  const rows = await tx
    .select({ day, sequence: lastJoined.name, interest: prospect.interest, count: count() })
    .from(prospect)
    .leftJoinLateral(lastJoined, sql`true`)
    .where(sql`${prospect.interest} is not null and ${prospect.updatedAt} >= ${since.toISOString()}::timestamptz`)
    .groupBy(day, lastJoined.name, prospect.interest)
    .orderBy(day);
  return rows.map((row) => ({ ...row, interest: row.interest as string }));
}

/**
 * The workspace's figures since a date, the shape another app reads to measure each prospecting
 * stage (prospects found, emails sent, replies, sign-ups). Counts only: no names, no addresses.
 */
export async function figuresOf(db: Database, workspaceId: string, since: Date): Promise<Figures> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [named] = await tx.select({ id: workspace.id, name: workspace.name }).from(workspace).where(eq(workspace.id, workspaceId));
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
    const daily: DailyFigures = { prospects: await prospectsAddedByDay(tx, since), sent: await sentBySequence(tx, since), signals: await signalsBySequence(tx, since), interest: await interestBySequence(tx, since) };
    return { workspace: named, since: since.toISOString(), prospects, sent, signals, steps, people, interest: interest.map((row) => ({ interest: row.interest as string, count: row.count })), daily };
  });
}
