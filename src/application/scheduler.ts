import { and, asc, count, desc, eq, gte, inArray, lt, min, notExists, sql } from "drizzle-orm";
import {
  addressToUse,
  contactKindOf,
  dailyAllowance,
  domainOf,
  emailFooter,
  isSuppressed,
  letterFooter,
  mailboxProblem,
  minutesLeftInWindow,
  nextStep,
  renderTemplate,
  sendsThisTick,
  sentByColdlyne,
  smsText,
  type Channel,
  type AddressChoice,
  type DataOrigin,
  type MergeValues,
  type OffLimits,
  type SenderIdentity,
  type StepOutcome,
} from "@/domain/sequences";
import { onePerDetail } from "@/domain/contacts";
import { acceptsMail } from "@/infrastructure/dns/mail-domain";
import { letterPdf, postalAddressOf } from "@/infrastructure/letters/pdf";
import { connection, outreach, signal } from "@/infrastructure/db/schema/connections";
import { company, contactDetail, person, whatsappConsent } from "@/infrastructure/db/schema/prospects";
import { enrollment, sequence, sequenceStep, stepMessage } from "@/infrastructure/db/schema/sequences";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { companyIsExcluded } from "@/domain/crm-exclusions";
import type { Database } from "@/infrastructure/db/client";
import { ProviderError } from "@/infrastructure/connectors/http";
import { withoutSecrets } from "@/infrastructure/connectors/without-secrets";
import { scheduledWorkChanged } from "@/infrastructure/scheduling/scheduled-work";
import { connectionsWith, openConnection, type OpenedConnection } from "./connections";
import { ownDetailsFirst } from "./directory";
import { addToSuppressionList, advance, bounce, dueEnrollments, stopEnrollments, suppressedIn, type DueEnrollment } from "./enrollments";
import { markFailing, mailFailing, recordOutreach, syncConnection } from "./signals";
import type { SentMessage } from "./ports";
import type { Services } from "./services";
import { unsubscribeUrl } from "./unsubscribe";
import { senderOf, settingsOf, type WorkspaceSettings } from "./workspace-settings";

/**
 * Sending, a few at a time: every run reads what came back first, so a reply stops the next message
 * rather than races it; then whoever is due gets their step, within the window, the caps and the
 * approvals. Nothing here decides what's allowed: `domain/sequences` does, whoever asked.
 */

const WEEK_MS = 7 * 86_400_000;
const HOUR_MS = 3_600_000;
const MAX_ATTEMPTS = 3;

export interface TickResult {
  sent: number;
  queued: number;
  tasks: number;
  skipped: number;
  failed: number;
}

type SequenceRow = typeof sequence.$inferSelect;
type StepRow = typeof sequenceStep.$inferSelect;
type MessageRow = typeof stepMessage.$inferSelect;

interface Budget {
  opened: OpenedConnection;
  /** How many it may still send today, and how many it has sent in this run. */
  leftToday: number;
  sentThisRun: number;
  atStart: number;
}

interface Tick {
  services: Services;
  workspaceId: string;
  now: Date;
  settings: WorkspaceSettings;
  sender: SenderIdentity | null;
  sequences: Map<string, SequenceRow>;
  steps: Map<string, StepRow[]>;
  budgets: Map<string, Budget>;
  domains: Map<string, boolean>;
  result: TickResult;
}

/** Every workspace with someone due, on the trusted path: their workspaces aren't known yet. */
export async function workspacesWithDueWork(db: Database, now: Date): Promise<string[]> {
  const rows = await db
    .selectDistinct({ workspaceId: enrollment.workspaceId })
    .from(enrollment)
    .innerJoin(sequence, eq(sequence.id, enrollment.sequenceId))
    .where(and(eq(sequence.status, "running"), eq(enrollment.status, "active"), sql`${enrollment.nextDueAt} <= ${now.toISOString()}::timestamptz`));
  return rows.map((row) => row.workspaceId);
}

/**
 * A sequence nobody is left on is over: it stops being a reason to run. Someone added later starts
 * it again. Trusted path: this looks across workspaces, at statuses only.
 */
export async function finishEmptiedSequences(db: Database): Promise<number> {
  const stillOn = db
    .select({ id: enrollment.id })
    .from(enrollment)
    .where(and(eq(enrollment.sequenceId, sequence.id), inArray(enrollment.status, ["active", "waiting_member"])));
  const finished = await db
    .update(sequence)
    .set({ status: "finished" })
    .where(and(eq(sequence.status, "running"), notExists(stillOn)))
    .returning({ id: sequence.id });
  return finished.length;
}

const STILL_ON_A_SEQUENCE = inArray(enrollment.status, ["active", "waiting_member"]);

/** Every workspace with someone still on a sequence at a company that refused commercial use of its data, on the trusted path. Nothing need be due: a call waiting for a member isn't. */
async function workspacesWithRefusedCompanies(db: Database): Promise<string[]> {
  const rows = await db
    .selectDistinct({ workspaceId: enrollment.workspaceId })
    .from(enrollment)
    .innerJoin(company, eq(company.id, enrollment.companyId))
    .where(and(eq(company.registryOptOut, true), STILL_ON_A_SEQUENCE));
  return rows.map((row) => row.workspaceId);
}

/** A company can refuse at any time, and any workspace of its group may be the one to hear it: whoever of it is still on a sequence here stops. */
async function stopRefusedCompanies(db: Database, workspaceId: string) {
  await withWorkspace(db, workspaceId, async (tx) => {
    const refused = await tx
      .select({ id: enrollment.id })
      .from(enrollment)
      .innerJoin(company, eq(company.id, enrollment.companyId))
      .where(and(eq(company.registryOptOut, true), STILL_ON_A_SEQUENCE));
    await stopEnrollments(tx, refused.map(({ id }) => id), "registry_opt_out");
  });
}

/** One scheduled run, over every workspace with something due. One workspace's trouble is none of the others'. */
export async function runScheduler(services: Services): Promise<{ workspaces: number; sent: number }> {
  const workspaces = [...new Set([...(await workspacesWithDueWork(services.db, services.now())), ...(await workspacesWithRefusedCompanies(services.db))])];
  let sent = 0;
  for (const workspaceId of workspaces) {
    try {
      sent += (await tickWorkspace(services, workspaceId)).sent;
    } catch (error) {
      console.error("The scheduler failed on a workspace", workspaceId, error instanceof Error ? error.message : error);
    }
  }
  if ((await finishEmptiedSequences(services.db)) > 0) scheduledWorkChanged();
  return { workspaces: workspaces.length, sent };
}

/** One workspace's turn: what came back, the health of its mailboxes, then whoever is due. */
export async function tickWorkspace(services: Services, workspaceId: string): Promise<TickResult> {
  const now = services.now();
  const result: TickResult = { sent: 0, queued: 0, tasks: 0, skipped: 0, failed: 0 };
  await recoverInterrupted(services.db, workspaceId, now);
  await stopRefusedCompanies(services.db, workspaceId);
  const first = await withWorkspace(services.db, workspaceId, (tx) => dueEnrollments(tx, now));
  if (first.length === 0) return result;
  const settings = await settingsOf(services.db, workspaceId);
  const tick: Tick = { services, workspaceId, now, settings, sender: senderOf(settings), sequences: new Map(), steps: new Map(), budgets: new Map(), domains: new Map(), result };
  await loadSequences(tick, first);
  await prepareConnections(tick, first);
  const due = await withWorkspace(services.db, workspaceId, (tx) => dueEnrollments(tx, now));
  for (const row of due) await takeTurn(tick, row);
  return result;
}

/** One person's trouble is no one else's: the others still get their turn, and this one goes behind them for a while rather than first again on the next run. */
async function takeTurn(tick: Tick, due: DueEnrollment) {
  try {
    await process(tick, due);
  } catch (error) {
    console.error("The scheduler failed on someone's turn", due.id, error instanceof Error ? error.message : error);
    tick.result.failed += 1;
    await withWorkspace(tick.services.db, tick.workspaceId, (tx) => tx.update(enrollment).set({ nextDueAt: new Date(tick.now.getTime() + HOUR_MS) }).where(and(eq(enrollment.id, due.id), eq(enrollment.status, "active")))).catch(() => undefined);
  }
}

/** A connection that can't even be opened is left out of this run: whoever needs it waits, and the others go on. */
async function openForThisRun(tick: Tick, id: string): Promise<OpenedConnection | null> {
  try {
    return await openConnection(tick.services, tick.workspaceId, id);
  } catch (error) {
    console.error("The scheduler couldn't open a connection", id, error instanceof Error ? error.message : error);
    return null;
  }
}

/** A send that never reported back may or may not have left: a person decides, rather than risk writing twice. */
async function recoverInterrupted(db: Database, workspaceId: string, now: Date) {
  await withWorkspace(db, workspaceId, async (tx) => {
    const stuck = await tx
      .update(stepMessage)
      .set({ status: "failed", note: "L’envoi a été interrompu : vérifiez s’il est parti avant de le relancer." })
      .where(and(eq(stepMessage.status, "sending"), lt(stepMessage.updatedAt, new Date(now.getTime() - HOUR_MS))))
      .returning({ enrollmentId: stepMessage.enrollmentId });
    if (stuck.length) await tx.update(enrollment).set({ status: "waiting_member", nextDueAt: null }).where(inArray(enrollment.id, stuck.map((row) => row.enrollmentId)));
  });
}

async function loadSequences(tick: Tick, due: readonly DueEnrollment[]) {
  const ids = [...new Set(due.map((row) => row.sequenceId))];
  await withWorkspace(tick.services.db, tick.workspaceId, async (tx) => {
    for (const row of await tx.select().from(sequence).where(inArray(sequence.id, ids))) tick.sequences.set(row.id, row);
    const steps = await tx.select().from(sequenceStep).where(inArray(sequenceStep.sequenceId, ids)).orderBy(asc(sequenceStep.position));
    for (const id of ids) tick.steps.set(id, steps.filter((step) => step.sequenceId === id));
  });
}

/** Reads the connections in play before anything goes out, pauses a mailbox that's hurting, and works out what each may send. */
async function prepareConnections(tick: Tick, due: readonly DueEnrollment[]) {
  const mailboxes = new Set(due.flatMap((row) => (row.mailboxId ? [row.mailboxId] : [])));
  const others = new Set<string>();
  for (const found of tick.sequences.values()) {
    for (const id of found.channels.email ?? []) mailboxes.add(id);
    if (found.channels.sms) others.add(found.channels.sms);
  }
  for (const id of [...mailboxes, ...others]) {
    const opened = await openForThisRun(tick, id);
    if (opened?.client.signalsSince && opened.row.status === "connected") await syncConnection(tick.services, tick.workspaceId, opened);
  }
  for (const id of mailboxes) {
    const opened = await openForThisRun(tick, id);
    if (!opened?.client.sendEmail) continue;
    await pauseIfHurting(tick, opened);
    const leftToday = await leftTodayOf(tick, opened);
    tick.budgets.set(id, { opened, leftToday, sentThisRun: 0, atStart: leftToday });
  }
}

async function activityOf(tick: Tick, connectionId: string) {
  const since = new Date(tick.now.getTime() - WEEK_MS);
  return withWorkspace(tick.services.db, tick.workspaceId, async (tx) => {
    const [{ sent }] = await tx
      .select({ sent: count() })
      .from(outreach)
      .where(and(eq(outreach.connectionId, connectionId), gte(outreach.sentAt, since)));
    const signals = await tx
      .select({ type: signal.type, count: sql<number>`count(distinct ${signal.address})`.mapWith(Number) })
      .from(signal)
      .innerJoin(outreach, eq(outreach.address, signal.address))
      .where(and(eq(outreach.connectionId, connectionId), gte(signal.at, since), inArray(signal.type, ["bounced", "opted_out"])))
      .groupBy(signal.type);
    const of = (type: string) => signals.find((row) => row.type === type)?.count ?? 0;
    return { sent, bounced: of("bounced"), optedOut: of("opted_out") };
  });
}

/** Stops a mailbox before it hurts its domain, and says so: only a member resumes it, on its page. */
async function pauseIfHurting(tick: Tick, opened: OpenedConnection) {
  if (opened.row.pausedAt) return;
  const problem = mailboxProblem(await activityOf(tick, opened.row.id));
  if (!problem) return;
  const { services, workspaceId, now } = tick;
  await withWorkspace(services.db, workspaceId, (tx) => tx.update(connection).set({ pausedAt: now, pausedReason: problem }).where(eq(connection.id, opened.row.id)));
  opened.row.pausedAt = now;
  opened.row.pausedReason = problem;
  await announcePause(services, workspaceId, opened, problem);
}

async function announcePause(services: Services, workspaceId: string, opened: OpenedConnection, problem: string) {
  const url = new URL(`/connections/${opened.row.kind}`, services.settings.BETTER_AUTH_URL).toString();
  for (const alert of await connectionsWith(services, workspaceId, "notify")) {
    await alert.client.notify?.({ event: "mailbox_paused", title: `${opened.row.label} est en pause`, text: problem, url }).catch(() => undefined);
  }
  if (opened.row.connectedBy) await mailFailing(services, opened.row.connectedBy, opened.row.kind, opened.row.label, problem);
}

/** What this mailbox may still send today, its ramp-up counted from its very first message. */
async function leftTodayOf(tick: Tick, opened: OpenedConnection): Promise<number> {
  if (opened.row.pausedAt || opened.row.status !== "connected") return 0;
  const [row] = await withWorkspace(tick.services.db, tick.workspaceId, (tx) =>
    tx
      .select({
        first: min(outreach.sentAt),
        today: sql<number>`count(*) filter (where (${outreach.sentAt} at time zone 'Europe/Paris')::date = (${tick.now.toISOString()}::timestamptz at time zone 'Europe/Paris')::date)`.mapWith(Number),
      })
      .from(outreach)
      .where(eq(outreach.connectionId, opened.row.id)),
  );
  return Math.max(0, dailyAllowance(row.first ? new Date(row.first) : null, tick.now, tick.settings.mailboxDailyCap) - (row.today ?? 0));
}

interface PersonFacts {
  values: MergeValues;
  origin: DataOrigin;
  contacts: { kind: string; value: string; page: string | null }[];
  whatsappConsent: boolean;
  address: { name: string; company: string; street: string | null; postcode: string | null; city: string | null };
  company: { name: string; siren: string | null; website: string | null };
  suppressed: OffLimits;
  /** What this enrollment already wrote to, the latest first: a conversation keeps its address. */
  used: string[];
}

async function factsOf(tick: Tick, due: DueEnrollment): Promise<PersonFacts> {
  return withWorkspace(tick.services.db, tick.workspaceId, async (tx) => {
    const [row] = await tx
      .select({ firstName: person.firstName, lastName: person.lastName, role: person.role, source: person.source, consent: whatsappConsent.agreedAt, company: company.name, siren: company.siren, website: company.website, street: company.street, postcode: company.postcode, city: company.city })
      .from(person)
      .innerJoin(company, eq(company.id, person.companyId))
      .leftJoin(whatsappConsent, eq(whatsappConsent.personId, person.id))
      .where(eq(person.id, due.personId));
    const contacts = onePerDetail(await tx.select({ kind: contactDetail.kind, value: contactDetail.value, page: contactDetail.page }).from(contactDetail).where(eq(contactDetail.personId, due.personId)).orderBy(...ownDetailsFirst));
    const used = await tx.select({ address: outreach.address }).from(outreach).where(eq(outreach.enrollmentId, due.id)).orderBy(desc(outreach.sentAt));
    const fullName = [row.firstName, row.lastName].filter(Boolean).join(" ");
    return {
      values: { firstName: row.firstName, lastName: row.lastName, company: row.company, role: row.role, city: row.city, sender: tick.sender?.name },
      origin: { source: row.source, company: row.company },
      contacts,
      whatsappConsent: row.consent !== null,
      address: { name: fullName, company: row.company, street: row.street, postcode: row.postcode, city: row.city },
      company: { name: row.company, siren: row.siren, website: row.website },
      suppressed: await suppressedIn(tx),
      used: used.map(({ address }) => address),
    };
  });
}

function addressFor(channel: Channel, facts: PersonFacts): AddressChoice<{ value: string; page?: string | null }> {
  if (channel === "letter") {
    const { street, postcode, city, company: name } = facts.address;
    return street && postcode && city ? { address: { value: `${name}, ${street}, ${postcode} ${city}` } } : { missing: "none" };
  }
  return addressToUse(facts.contacts, contactKindOf(channel), facts.used, facts.suppressed);
}

const BOUNCED_ELSEWHERE = "L’adresse connue est refusée : un autre espace du groupe l’a constaté.";

const NO_ADDRESS: Record<string, string> = { email: "Pas d’adresse email", letter: "Pas d’adresse postale", linkedin: "Pas de profil LinkedIn", instagram: "Pas de profil Instagram", messenger: "Pas de profil Facebook", x: "Pas de profil X" };

/** One person's turn: the next step that applies, skipping those they can't be reached on. */
async function process(tick: Tick, due: DueEnrollment) {
  const steps = tick.steps.get(due.sequenceId) ?? [];
  const facts = await factsOf(tick, due);
  // Any of their details on this workspace's own list stops them, not only the one the next step would use: sharing gives someone addresses this workspace never chose.
  if (facts.contacts.some(({ value }) => isSuppressed(value, facts.suppressed.refused)) || companyIsExcluded(facts.company, facts.suppressed.refused)) return stop(tick, due, "suppressed");
  let position = due.lastPosition;
  const outcome = due.lastOutcome as StepOutcome | null;
  for (let turn = 0; turn <= steps.length; turn++) {
    const step = nextStep(steps, position, outcome);
    if (!step) return finish(tick, due, position, outcome);
    const channel = step.channel as Channel;
    const { address, missing } = addressFor(channel, facts);
    if (missing === "bounced_here") return stop(tick, due, "suppressed");
    if (address) return sentByColdlyne(channel, facts.whatsappConsent) && (channel !== "whatsapp" || step.options.template) ? deliver(tick, due, step, facts, address) : openTask(tick, due, step, facts);
    await skip(tick, due, step, missing === "bounced_elsewhere" ? BOUNCED_ELSEWHERE : (NO_ADDRESS[channel] ?? "Pas de numéro de téléphone"), outcome);
    tick.result.skipped += 1;
    position = step.position;
    if (nextDueLater(steps, position, outcome)) return;
  }
}

/** Whether the step after this one must still wait: what's left then falls due on a later run. */
const nextDueLater = (steps: readonly StepRow[], position: number, outcome: StepOutcome | null) => (nextStep(steps, position, outcome)?.waitDays ?? 0) > 0;

async function finish(tick: Tick, due: DueEnrollment, position: number, outcome: StepOutcome | null) {
  await withWorkspace(tick.services.db, tick.workspaceId, (tx) => advance(tx, due.id, position, outcome ?? "done", tick.now));
}

async function stop(tick: Tick, due: DueEnrollment, reason: string) {
  await withWorkspace(tick.services.db, tick.workspaceId, (tx) => stopEnrollments(tx, [due.id], reason));
}

async function skip(tick: Tick, due: DueEnrollment, step: StepRow, note: string, outcome: StepOutcome | null) {
  await withWorkspace(tick.services.db, tick.workspaceId, async (tx) => {
    await tx.insert(stepMessage).values({ enrollmentId: due.id, stepId: step.id, channel: step.channel, status: "skipped", note }).onConflictDoUpdate({ target: [stepMessage.enrollmentId, stepMessage.stepId], set: { status: "skipped", note } });
    await advance(tx, due.id, step.position, outcome ?? "done", tick.now);
  });
}

/** A step a member does: it lands in their list for the day with its text, and the sequence waits for them. */
async function openTask(tick: Tick, due: DueEnrollment, step: StepRow, facts: PersonFacts) {
  const owner = tick.sequences.get(due.sequenceId)?.createdBy ?? null;
  const subject = step.subject ? renderTemplate(step.subject, facts.values).text : null;
  const { text: body } = renderTemplate(step.body, facts.values);
  await withWorkspace(tick.services.db, tick.workspaceId, async (tx) => {
    const [written] = await tx.select({ writtenBy: stepMessage.writtenBy, body: stepMessage.body, subject: stepMessage.subject }).from(stepMessage).where(and(eq(stepMessage.enrollmentId, due.id), eq(stepMessage.stepId, step.id)));
    const own = written && written.writtenBy !== "template" ? { subject: written.subject, body: written.body } : { subject, body };
    await tx
      .insert(stepMessage)
      .values({ enrollmentId: due.id, stepId: step.id, channel: step.channel, ...own, status: "to_do", assignedTo: owner })
      .onConflictDoUpdate({ target: [stepMessage.enrollmentId, stepMessage.stepId], set: { ...own, status: "to_do", assignedTo: owner } });
    await tx.update(enrollment).set({ status: "waiting_member", nextDueAt: null }).where(eq(enrollment.id, due.id));
  });
  tick.result.tasks += 1;
}

async function messageFor(tick: Tick, due: DueEnrollment, step: StepRow): Promise<MessageRow> {
  return withWorkspace(tick.services.db, tick.workspaceId, async (tx) => {
    await tx.insert(stepMessage).values({ enrollmentId: due.id, stepId: step.id, channel: step.channel, subject: step.subject, body: step.body, status: "draft" }).onConflictDoNothing();
    const [row] = await tx.select().from(stepMessage).where(and(eq(stepMessage.enrollmentId, due.id), eq(stepMessage.stepId, step.id)));
    return row;
  });
}

/** A message that needs a person: it goes no further until one has looked. */
async function holdForMember(tick: Tick, due: DueEnrollment, messageId: string, changes: Partial<MessageRow>) {
  await withWorkspace(tick.services.db, tick.workspaceId, async (tx) => {
    await tx.update(stepMessage).set(changes).where(eq(stepMessage.id, messageId));
    await tx.update(enrollment).set({ status: "waiting_member", nextDueAt: null }).where(eq(enrollment.id, due.id));
  });
}

/** Whether this mailbox may send one more now, so that what's left today spreads over what's left of the window. */
function roomIn(budget: Budget | undefined, minutesLeft: number): boolean {
  return Boolean(budget) && (budget as Budget).leftToday > 0 && (budget as Budget).sentThisRun < sendsThisTick((budget as Budget).atStart, minutesLeft);
}

/** The mailbox for this person: theirs once chosen, so a thread never changes hands; otherwise whichever has the most room. */
function mailboxFor(tick: Tick, sequenceRow: SequenceRow, due: DueEnrollment, minutesLeft: number): Budget | null {
  if (due.mailboxId) {
    const own = tick.budgets.get(due.mailboxId);
    return roomIn(own, minutesLeft) ? (own as Budget) : null;
  }
  const open = (sequenceRow.channels.email ?? []).map((id) => tick.budgets.get(id)).filter((budget): budget is Budget => roomIn(budget, minutesLeft));
  return open.sort((a, b) => b.leftToday - a.leftToday)[0] ?? null;
}

async function mailDomainWorks(tick: Tick, address: string): Promise<boolean> {
  const domain = domainOf(address);
  const known = tick.domains.get(domain);
  if (known !== undefined) return known;
  const works = await acceptsMail(domain, tick.services.dns);
  tick.domains.set(domain, works);
  return works;
}

interface Rendered {
  subject: string | null;
  body: string;
}

function render(message: MessageRow, facts: PersonFacts): { rendered: Rendered; missing: string[] } {
  const subject = renderTemplate(message.subject ?? "", facts.values);
  const body = renderTemplate(message.body ?? "", facts.values);
  return { rendered: { subject: subject.text || null, body: body.text }, missing: [...new Set([...subject.missing, ...body.missing])] };
}

/** A step Coldlyne sends itself: inside its window, within the caps, approved if the workspace asks for that. */
async function deliver(tick: Tick, due: DueEnrollment, step: StepRow, facts: PersonFacts, address: { value: string; page?: string | null }) {
  const sequenceRow = tick.sequences.get(due.sequenceId) as SequenceRow;
  const minutesLeft = minutesLeftInWindow(tick.now, sequenceRow.window);
  if (minutesLeft === 0 || !tick.sender) return;
  const message = await messageFor(tick, due, step);
  if (message.status === "sending" || message.status === "sent" || message.status === "failed" || message.status === "awaiting_approval") return;
  const { rendered, missing } = render(message, facts);
  if (missing.length) {
    await holdForMember(tick, due, message.id, { status: "failed", note: `Il manque ${missing.join(", ")} pour écrire ce message : corrigez-le ou retirez cette personne.` });
    tick.result.failed += 1;
    return;
  }
  if (tick.settings.approval === "approve_first" && message.status !== "approved") {
    await holdForMember(tick, due, message.id, { status: "awaiting_approval", subject: rendered.subject, body: rendered.body });
    tick.result.queued += 1;
    return;
  }
  const channel = step.channel as Channel;
  const budget = channel === "email" ? mailboxFor(tick, sequenceRow, due, minutesLeft) : null;
  if (channel === "email" && !budget) return;
  if (channel === "email" && !(await mailDomainWorks(tick, address.value))) return refuseAddress(tick, due, message, address.value);
  const connectionId = channel === "email" ? (budget as Budget).opened.row.id : channelConnection(sequenceRow, channel);
  const opened = connectionId ? (budget?.opened ?? (await openConnection(tick.services, tick.workspaceId, connectionId))) : null;
  if (!opened || opened.row.status !== "connected") return;
  const attempts = await claim(tick, message.id, opened.row.id);
  if (attempts === null) return;
  try {
    const origin: DataOrigin = { ...facts.origin, page: address.page };
    const sent = await sendThrough(tick, opened, due, step, rendered, facts, origin, address.value);
    await recordSent(tick, due, step, message.id, opened.row.id, address.value, sent, rendered);
    if (budget) {
      budget.leftToday -= 1;
      budget.sentThisRun += 1;
    }
    tick.result.sent += 1;
  } catch (error) {
    await recordFailure(tick, due, message, opened.row.id, attempts, error);
  }
}

const channelConnection = (row: SequenceRow, channel: Channel) => (channel === "sms" ? row.channels.sms : channel === "letter" ? row.channels.letter : channel === "whatsapp" ? row.channels.whatsapp : undefined) ?? null;

/** Nobody reads mail at that domain: writing would only be a bounce against this mailbox. */
async function refuseAddress(tick: Tick, due: DueEnrollment, message: MessageRow, address: string) {
  await withWorkspace(tick.services.db, tick.workspaceId, async (tx) => {
    await tx.update(stepMessage).set({ status: "skipped", note: `Le domaine de ${address} ne reçoit pas d’emails.` }).where(eq(stepMessage.id, message.id));
    await addToSuppressionList(tx, [{ value: address.toLowerCase(), reason: "bounced" }]);
    await bounce(tx, due, tick.now);
  });
  tick.result.skipped += 1;
}

/** Takes the message before calling the provider: two runs at once can't both send it. Null when another run has it. */
async function claim(tick: Tick, messageId: string, connectionId: string): Promise<number | null> {
  const [claimed] = await withWorkspace(tick.services.db, tick.workspaceId, (tx) =>
    tx
      .update(stepMessage)
      .set({ status: "sending", attempts: sql`${stepMessage.attempts} + 1`, connectionId, updatedAt: tick.now })
      .where(and(eq(stepMessage.id, messageId), inArray(stepMessage.status, ["draft", "approved"])))
      .returning({ attempts: stepMessage.attempts }),
  );
  return claimed?.attempts ?? null;
}

async function threadOf(tick: Tick, enrollmentId: string) {
  const rows = await withWorkspace(tick.services.db, tick.workspaceId, (tx) =>
    tx
      .select({ messageId: stepMessage.messageId, subject: stepMessage.subject })
      .from(stepMessage)
      .where(and(eq(stepMessage.enrollmentId, enrollmentId), eq(stepMessage.channel, "email"), eq(stepMessage.status, "sent")))
      .orderBy(asc(stepMessage.sentAt)),
  );
  return { references: rows.flatMap((row) => (row.messageId ? [row.messageId] : [])), firstSubject: rows[0]?.subject ?? null };
}

async function sendThrough(tick: Tick, opened: OpenedConnection, due: DueEnrollment, step: StepRow, rendered: Rendered, facts: PersonFacts, origin: DataOrigin, address: string): Promise<SentMessage> {
  const sender = tick.sender as SenderIdentity;
  const url = unsubscribeUrl(tick.services.settings, tick.workspaceId, address);
  switch (step.channel) {
    case "email": {
      const { references, firstSubject } = await threadOf(tick, due.id);
      const subject = rendered.subject ?? (firstSubject ? `Re: ${firstSubject}` : facts.values.company ?? sender.name);
      const text = `${rendered.body}\n\n${emailFooter(sender, origin, url)}`;
      const headers = { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
      return opened.client.sendEmail!({ to: address, subject, text, headers, inReplyTo: references.at(-1), references });
    }
    case "sms":
      return opened.client.sendSms!({ to: address, text: smsText(sender.name, rendered.body) });
    case "letter": {
      const { name, company: companyName, street, postcode, city } = facts.address;
      const to = { name, company: companyName, lines: [street as string], postcode: postcode as string, city: city as string, country: "FR" as const };
      const from = postalAddressOf(sender);
      const pdf = await letterPdf({ from, to, body: rendered.body, footer: letterFooter(sender, origin, url) });
      return opened.client.postLetter!({ to, from, pdf, reference: due.id });
    }
    case "whatsapp": {
      const parameters = (step.options.parameters ?? []).map((parameter) => renderTemplate(parameter, facts.values).text);
      return opened.client.sendTemplate!({ to: address, template: step.options.template as string, language: step.options.language ?? "fr", parameters });
    }
    default:
      throw new Error(`Coldlyne n’envoie pas ce canal lui-même : ${step.channel}.`);
  }
}

/** Keeps the words that actually left, fields filled in: this is the record of what the person read. */
async function recordSent(tick: Tick, due: DueEnrollment, step: StepRow, messageId: string, connectionId: string, address: string, sent: SentMessage, rendered: Rendered) {
  const { services, workspaceId, now } = tick;
  await recordOutreach(services.db, workspaceId, { connectionId, channel: step.channel as Channel, address, messageId: sent.messageId, externalId: sent.externalId, enrollmentId: due.id, at: now });
  await withWorkspace(services.db, workspaceId, async (tx) => {
    await tx.update(stepMessage).set({ status: "sent", subject: rendered.subject, body: rendered.body, externalId: sent.externalId, messageId: sent.messageId ?? null, sentAt: now, note: null }).where(eq(stepMessage.id, messageId));
    if (step.channel === "email" && !due.mailboxId) await tx.update(enrollment).set({ mailboxId: connectionId }).where(eq(enrollment.id, due.id));
    await advance(tx, due.id, step.position, "done", now);
  });
}

/** A refused key is the connection's problem; anything else may pass. Three tries, then a person looks. */
async function recordFailure(tick: Tick, due: DueEnrollment, message: MessageRow, connectionId: string, attempts: number, error: unknown) {
  const { services, workspaceId } = tick;
  const note = error instanceof Error ? withoutSecrets(error.message) : "Le service n’a pas répondu.";
  if (error instanceof ProviderError && (error.status === 401 || error.status === 403)) await markFailing(services, workspaceId, connectionId, error);
  tick.result.failed += 1;
  if (attempts >= MAX_ATTEMPTS) return holdForMember(tick, due, message.id, { status: "failed", note });
  await withWorkspace(services.db, workspaceId, (tx) =>
    tx
      .update(stepMessage)
      .set({ status: message.status === "approved" ? "approved" : "draft", note })
      .where(eq(stepMessage.id, message.id)),
  );
}

/** A member resumes a paused mailbox: its reason is gone from the page, and its caps pick up where they were. */
export async function resumeMailbox(db: Database, workspaceId: string, connectionId: string): Promise<boolean> {
  const updated = await withWorkspace(db, workspaceId, (tx) => tx.update(connection).set({ pausedAt: null, pausedReason: null }).where(eq(connection.id, connectionId)).returning({ id: connection.id }));
  return updated.length > 0;
}
