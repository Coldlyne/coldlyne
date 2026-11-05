import { and, asc, count, desc, eq, gte, inArray, max, sql } from "drizzle-orm";
import type { Capability } from "@/domain/connectors";
import { dmarcRecordsIn, spfRecordsIn, type MailboxProvider } from "@/domain/deliverability";
import { CHANNELS, DEFAULT_WINDOW, domainOf, sentByColdlyne, STEP_CONDITIONS, windowProblem, type Channel, type SendingWindow, type StepCondition } from "@/domain/sequences";
import { checkSendingDomain, lookUpDomain } from "@/infrastructure/dns/checks";
import type { Database } from "@/infrastructure/db/client";
import { company, person } from "@/infrastructure/db/schema/prospects";
import { enrollment, sequence, sequenceStep, stepMessage, type SequenceChannels, type StepOptions } from "@/infrastructure/db/schema/sequences";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { scheduledWorkChanged } from "@/infrastructure/scheduling/scheduled-work";
import { connectionsOf, type ConnectionView } from "./connections";
import { releaseFromStep, startWaiting } from "./enrollments";
import type { Services } from "./services";
import { senderOf, settingsOf } from "./workspace-settings";

export type { SequenceChannels, StepOptions };

export interface StepInput {
  channel: Channel;
  /** Days after the step before it ended. */
  waitDays?: number;
  condition?: StepCondition;
  subject?: string | null;
  body: string;
  options?: StepOptions;
}

export interface SequenceInput {
  name: string;
  steps: readonly StepInput[];
  channels?: SequenceChannels;
  window?: SendingWindow;
}

export type Saved = { ok: true; id: string } | { ok: false; error: string };

function stepProblem(step: StepInput): string | null {
  if (!CHANNELS.includes(step.channel)) return `Ce canal n’existe pas : ${step.channel}.`;
  if (step.condition && !STEP_CONDITIONS.includes(step.condition)) return `Cette condition n’existe pas : ${step.condition}.`;
  if (step.waitDays !== undefined && (!Number.isInteger(step.waitDays) || step.waitDays < 0)) return "Le délai d’une étape se compte en jours entiers.";
  if (!step.body.trim()) return "Chaque étape a besoin d’un texte.";
  return null;
}

const CAPABILITY_OF: Record<keyof SequenceChannels, Capability> = { email: "send_email", sms: "send_sms", letter: "post_letter", whatsapp: "send_whatsapp", call: "place_call" };

const canDo = (view: ConnectionView, capability: Capability) => view.capabilities.includes(capability);

/** A new sequence sends through everything the workspace connected: every mailbox, and the first provider of each kind. */
function channelsByDefault(views: readonly ConnectionView[]): SequenceChannels {
  const first = (capability: Capability) => views.find((view) => canDo(view, capability))?.id;
  return { email: views.filter((view) => canDo(view, "send_email")).map((view) => view.id), sms: first("send_sms"), letter: first("post_letter"), whatsapp: first("send_whatsapp"), call: first("place_call") };
}

function channelsProblem(channels: SequenceChannels, views: readonly ConnectionView[]): string | null {
  const given = Object.entries(channels).flatMap(([key, value]) => (Array.isArray(value) ? value : value ? [value] : []).map((id) => ({ key: key as keyof SequenceChannels, id })));
  const wrong = given.find(({ key, id }) => !views.some((view) => view.id === id && canDo(view, CAPABILITY_OF[key])));
  return wrong ? `Cette connexion ne peut pas servir pour ce canal : ${wrong.key}.` : null;
}

const stepValues = (sequenceId: string, step: StepInput, position: number) => ({
  sequenceId,
  position,
  channel: step.channel,
  waitDays: step.waitDays ?? 0,
  condition: step.condition ?? "always",
  subject: step.subject?.trim() || null,
  body: step.body,
  options: step.options ?? {},
});

/** A sequence, as a draft: nothing leaves until it is launched. */
export async function createSequence(services: Services, workspaceId: string, userId: string, input: SequenceInput): Promise<Saved> {
  if (!input.name.trim()) return { ok: false, error: "Donnez un nom à cette séquence." };
  const problem = input.steps.map(stepProblem).find(Boolean) ?? (input.window ? windowProblem(input.window) : null);
  if (problem) return { ok: false, error: problem };
  const views = await connectionsOf(services, workspaceId);
  const channels = input.channels ?? channelsByDefault(views);
  const wrong = channelsProblem(channels, views);
  if (wrong) return { ok: false, error: wrong };
  const id = await withWorkspace(services.db, workspaceId, async (tx) => {
    const [created] = await tx.insert(sequence).values({ name: input.name.trim(), channels, window: input.window ?? DEFAULT_WINDOW, createdBy: userId }).returning({ id: sequence.id });
    if (input.steps.length) await tx.insert(sequenceStep).values(input.steps.map((step, position) => stepValues(created.id, step, position)));
    return created.id;
  });
  return { ok: true, id };
}

export interface SequenceSummary {
  id: string;
  name: string;
  status: "draft" | "pending_approval" | "running" | "paused" | "finished";
  steps: number;
  people: number;
  active: number;
  stopped: number;
  sent: number;
  replied: number;
}

/** The workspace's sequences, the latest first, with where each stands. */
export async function sequencesOf(db: Database, workspaceId: string): Promise<SequenceSummary[]> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const rows = await tx.select({ id: sequence.id, name: sequence.name, status: sequence.status }).from(sequence).orderBy(desc(sequence.createdAt));
    const steps = await tx.select({ id: sequenceStep.sequenceId, count: count() }).from(sequenceStep).groupBy(sequenceStep.sequenceId);
    const people = await tx.select({ id: enrollment.sequenceId, status: enrollment.status, reason: enrollment.stopReason, count: count() }).from(enrollment).groupBy(enrollment.sequenceId, enrollment.status, enrollment.stopReason);
    const sent = await tx
      .select({ id: enrollment.sequenceId, count: count() })
      .from(stepMessage)
      .innerJoin(enrollment, eq(enrollment.id, stepMessage.enrollmentId))
      .where(inArray(stepMessage.status, ["sent", "done"]))
      .groupBy(enrollment.sequenceId);
    const sum = (id: string, keep: (row: (typeof people)[number]) => boolean) => people.filter((row) => row.id === id && keep(row)).reduce((total, row) => total + row.count, 0);
    return rows.map((row) => ({
      ...row,
      steps: steps.find((found) => found.id === row.id)?.count ?? 0,
      people: sum(row.id, () => true),
      active: sum(row.id, (found) => found.status === "active" || found.status === "waiting_member"),
      stopped: sum(row.id, (found) => found.status === "stopped"),
      sent: sent.find((found) => found.id === row.id)?.count ?? 0,
      replied: sum(row.id, (found) => found.reason === "replied"),
    }));
  });
}

/** One sequence, its steps and who is on it. */
export async function sequenceOf(db: Database, workspaceId: string, sequenceId: string) {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [row] = await tx.select().from(sequence).where(eq(sequence.id, sequenceId));
    if (!row) return null;
    const steps = await tx.select().from(sequenceStep).where(eq(sequenceStep.sequenceId, sequenceId)).orderBy(asc(sequenceStep.position));
    const reached = await tx
      .select({ stepId: stepMessage.stepId, status: stepMessage.status, count: count() })
      .from(stepMessage)
      .innerJoin(enrollment, eq(enrollment.id, stepMessage.enrollmentId))
      .where(eq(enrollment.sequenceId, sequenceId))
      .groupBy(stepMessage.stepId, stepMessage.status);
    const people = await tx.select({ status: enrollment.status, reason: enrollment.stopReason, count: count() }).from(enrollment).where(eq(enrollment.sequenceId, sequenceId)).groupBy(enrollment.status, enrollment.stopReason);
    return { ...row, steps, reached, people };
  });
}

/** Changes a sequence, running or not: what has already gone stays as it went, the rest follows the new rules. */
export async function updateSequence(services: Services, workspaceId: string, sequenceId: string, changes: { name?: string; channels?: SequenceChannels; window?: SendingWindow }): Promise<{ ok: true } | { ok: false; error: string }> {
  const problem = changes.window ? windowProblem(changes.window) : null;
  if (problem) return { ok: false, error: problem };
  if (changes.channels) {
    const wrong = channelsProblem(changes.channels, await connectionsOf(services, workspaceId));
    if (wrong) return { ok: false, error: wrong };
  }
  const name = changes.name?.trim();
  const updated = await withWorkspace(services.db, workspaceId, (tx) =>
    tx
      .update(sequence)
      .set({ ...changes, ...(name ? { name } : { name: undefined }), updatedAt: sql`now()` })
      .where(eq(sequence.id, sequenceId))
      .returning({ id: sequence.id }),
  );
  return updated.length ? { ok: true } : { ok: false, error: "Cette séquence n’existe pas." };
}

/** Puts a step after this position, or at the end. People already past that point don't go back. */
export async function addStep(db: Database, workspaceId: string, sequenceId: string, step: StepInput, afterPosition?: number): Promise<Saved> {
  const problem = stepProblem(step);
  if (problem) return { ok: false, error: problem };
  return withWorkspace(db, workspaceId, async (tx) => {
    const [row] = await tx.select({ id: sequence.id }).from(sequence).where(eq(sequence.id, sequenceId));
    if (!row) return { ok: false, error: "Cette séquence n’existe pas." };
    const [{ last }] = await tx.select({ last: max(sequenceStep.position) }).from(sequenceStep).where(eq(sequenceStep.sequenceId, sequenceId));
    const position = afterPosition === undefined ? (last ?? -1) + 1 : afterPosition + 1;
    if (afterPosition !== undefined) {
      await tx.update(sequenceStep).set({ position: sql`${sequenceStep.position} + 1` }).where(and(eq(sequenceStep.sequenceId, sequenceId), gte(sequenceStep.position, position)));
      await tx.update(enrollment).set({ lastPosition: sql`${enrollment.lastPosition} + 1` }).where(and(eq(enrollment.sequenceId, sequenceId), gte(enrollment.lastPosition, position)));
    }
    const [created] = await tx.insert(sequenceStep).values(stepValues(sequenceId, step, position)).returning({ id: sequenceStep.id });
    return { ok: true, id: created.id };
  });
}

/**
 * Rewrites a step, while it runs if need be. Messages made from its old text that haven't left are
 * dropped and made again, approved or not: nobody approved the new words. Texts an assistant or a
 * member wrote for one person stay theirs.
 */
export async function updateStep(db: Database, workspaceId: string, stepId: string, changes: Partial<StepInput>): Promise<{ ok: true } | { ok: false; error: string }> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [row] = await tx.select().from(sequenceStep).where(eq(sequenceStep.id, stepId));
    if (!row) return { ok: false, error: "Cette étape n’existe pas." };
    const merged: StepInput = { channel: (changes.channel ?? row.channel) as Channel, waitDays: changes.waitDays ?? row.waitDays, condition: changes.condition ?? row.condition, subject: changes.subject === undefined ? row.subject : changes.subject, body: changes.body ?? row.body, options: changes.options ?? row.options };
    const problem = stepProblem(merged);
    if (problem) return { ok: false, error: problem };
    await tx.update(sequenceStep).set({ channel: merged.channel, waitDays: merged.waitDays, condition: merged.condition, subject: merged.subject?.trim() || null, body: merged.body, options: merged.options, updatedAt: sql`now()` }).where(eq(sequenceStep.id, stepId));
    await tx.delete(stepMessage).where(and(eq(stepMessage.stepId, stepId), eq(stepMessage.writtenBy, "template"), inArray(stepMessage.status, ["draft", "awaiting_approval", "approved", "failed"])));
    await tx.update(stepMessage).set({ subject: merged.subject?.trim() || null, body: merged.body }).where(and(eq(stepMessage.stepId, stepId), eq(stepMessage.writtenBy, "template"), eq(stepMessage.status, "to_do")));
    return { ok: true };
  });
}

/** Removes a step, while it runs if need be. What it already sent stays on record; whoever waited on it moves on. */
export async function removeStep(db: Database, workspaceId: string, stepId: string, now: Date): Promise<boolean> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [row] = await tx.select({ position: sequenceStep.position }).from(sequenceStep).where(eq(sequenceStep.id, stepId));
    if (!row) return false;
    await tx.update(sequenceStep).set({ position: -1 }).where(eq(sequenceStep.id, stepId));
    await releaseFromStep(tx, stepId, row.position, now);
    await tx.delete(stepMessage).where(and(eq(stepMessage.stepId, stepId), inArray(stepMessage.status, ["draft", "awaiting_approval", "approved", "to_do", "failed"])));
    await tx.delete(sequenceStep).where(eq(sequenceStep.id, stepId));
    return true;
  });
}

const MAILBOX_PROVIDER: Record<string, MailboxProvider> = { gmail: "google", microsoft365: "microsoft" };

/** What stops this mailbox's domain being trusted. Each provider's DKIM can only be checked where its selector is known. */
async function mailboxDomainProblem(services: Services, view: ConnectionView): Promise<string | null> {
  const domain = domainOf(view.label);
  const provider = MAILBOX_PROVIDER[view.kind];
  try {
    if (provider) {
      const { report } = await checkSendingDomain(domain, provider, { resolver: services.dns });
      const missing = (["spf", "dkim", "dmarc"] as const).filter((part) => !report[part].ok);
      return missing.length ? `Le domaine ${domain} n’est pas prêt (${missing.join(", ").toUpperCase()}) : voyez la page Délivrabilité.` : null;
    }
    const answers = await lookUpDomain(domain, "ovh", { resolver: services.dns });
    const missing = [spfRecordsIn(answers.apexTxt).length ? null : "SPF", dmarcRecordsIn(answers.dmarcTxt).length ? null : "DMARC"].filter(Boolean);
    return missing.length ? `Le domaine ${domain} n’est pas prêt (${missing.join(", ")}) : voyez la page Délivrabilité.` : null;
  } catch {
    return `Impossible de lire le DNS de ${domain} pour le moment : réessayez dans un instant.`;
  }
}

const CHANNEL_NAMES: Partial<Record<Channel, string>> = { email: "une boîte", sms: "un fournisseur de SMS", letter: "un service de courrier" };

/** Why a sequence can't start yet, in the member's words. These can't be waived: the law and the domain's reputation depend on them. */
export async function launchProblems(services: Services, workspaceId: string, sequenceId: string): Promise<string[]> {
  const found = await sequenceOf(services.db, workspaceId, sequenceId);
  if (!found) return ["Cette séquence n’existe pas."];
  const problems: string[] = [];
  if (found.steps.length === 0) problems.push("Cette séquence n’a aucune étape.");
  if (!found.people.some((row) => row.status === "active")) problems.push("Personne n’attend sur cette séquence : ajoutez des prospects.");
  if (!senderOf(await settingsOf(services.db, workspaceId))) problems.push("Indiquez dans les Réglages le nom et l’adresse de l’expéditeur : la loi demande que chaque message les donne.");
  const views = await connectionsOf(services, workspaceId);
  for (const channel of new Set(found.steps.map((step) => step.channel as Channel))) {
    if (!sentByColdlyne(channel)) continue;
    const key = channel as "email" | "sms" | "letter";
    const given = found.channels[key];
    if (!(Array.isArray(given) ? given.length : given)) problems.push(`Cette séquence a besoin d’${CHANNEL_NAMES[channel]} connecté${channel === "email" ? "e" : ""}.`);
  }
  if (found.steps.some((step) => step.channel === "email")) {
    const mailboxes = views.filter((view) => found.channels.email?.includes(view.id));
    for (const domain of new Set(mailboxes.map((view) => domainOf(view.label)))) {
      const problem = await mailboxDomainProblem(services, mailboxes.find((view) => domainOf(view.label) === domain) as ConnectionView);
      if (problem) problems.push(problem);
    }
  }
  return problems;
}

export type Launched = { ok: true; status: "running" | "pending_approval" } | { ok: false; problems: string[] };

/**
 * Starts a sequence. Where a workspace approves first, an assistant can only ask: the sequence waits
 * for a member, on its page. Nothing lets an assistant loosen that setting.
 */
export async function launchSequence(services: Services, workspaceId: string, sequenceId: string, actor: "member" | "assistant"): Promise<Launched> {
  const problems = await launchProblems(services, workspaceId, sequenceId);
  if (problems.length) return { ok: false, problems };
  const { approval } = await settingsOf(services.db, workspaceId);
  const status = approval === "approve_first" && actor === "assistant" ? "pending_approval" : "running";
  const now = services.now();
  await withWorkspace(services.db, workspaceId, async (tx) => {
    await tx.update(sequence).set({ status, launchedAt: status === "running" ? now : null, updatedAt: sql`now()` }).where(eq(sequence.id, sequenceId));
    if (status === "running") await startWaiting(tx, sequenceId, now);
  });
  scheduledWorkChanged();
  return { ok: true, status };
}

/** Pausing keeps everyone where they are; what's due goes when it resumes, within its window and caps. */
export async function setPaused(db: Database, workspaceId: string, sequenceId: string, paused: boolean): Promise<boolean> {
  const updated = await withWorkspace(db, workspaceId, (tx) =>
    tx
      .update(sequence)
      .set({ status: paused ? "paused" : "running", updatedAt: sql`now()` })
      .where(and(eq(sequence.id, sequenceId), inArray(sequence.status, paused ? ["running"] : ["paused"])))
      .returning({ id: sequence.id }),
  );
  scheduledWorkChanged();
  return updated.length > 0;
}

export interface PersonOnSequence {
  enrollmentId: string;
  prospectId: string;
  person: string;
  company: string;
  status: "active" | "waiting_member" | "stopped" | "finished";
  stopReason: string | null;
  nextDueAt: Date | null;
  lastPosition: number;
}

/** Who is on a sequence and where each stands, those still going first. */
export async function peopleOn(db: Database, workspaceId: string, sequenceId: string): Promise<PersonOnSequence[]> {
  return withWorkspace(db, workspaceId, (tx) =>
    tx
      .select({ enrollmentId: enrollment.id, prospectId: enrollment.prospectId, person: sql<string>`trim(coalesce(${person.firstName}, '') || ' ' || ${person.lastName})`, company: company.name, status: enrollment.status, stopReason: enrollment.stopReason, nextDueAt: enrollment.nextDueAt, lastPosition: enrollment.lastPosition })
      .from(enrollment)
      .innerJoin(person, eq(person.id, enrollment.personId))
      .innerJoin(company, eq(company.id, enrollment.companyId))
      .where(eq(enrollment.sequenceId, sequenceId))
      .orderBy(asc(enrollment.status), asc(enrollment.nextDueAt))
      .limit(200),
  );
}
