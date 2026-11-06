import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connectWithFields } from "@/application/connections";
import { confirmContact } from "@/application/contacts";
import { enroll, removeFromSequence } from "@/application/enrollments";
import { approveMessages, messagesToReview, retryMessage, writeMessage } from "@/application/messages";
import { addFromRegistry, createList, prospectsOf } from "@/application/prospects";
import { finishEmptiedSequences, resumeMailbox, runScheduler, tickWorkspace, workspacesWithDueWork } from "@/application/scheduler";
import { whatIsScheduled } from "@/application/scheduled-work";
import { addStep, createSequence, launchProblems, launchSequence, removeStep, sequenceOf, sequencesOf, setPaused, updateSequence, updateStep, type StepInput } from "@/application/sequences";
import type { Services } from "@/application/services";
import { recordOutreach, recordSignals } from "@/application/signals";
import { recordWhatsappConsent } from "@/application/threads";
import { readUnsubscribeToken, unsubscribe, unsubscribeSubject, unsubscribeToken, unsubscribeUrl } from "@/application/unsubscribe";
import { saveSettings } from "@/application/workspace-settings";
import { fromRegistry } from "@/domain/registry";
import type { Database } from "@/infrastructure/db/client";
import { connection, outreach } from "@/infrastructure/db/schema/connections";
import { prospect, suppression } from "@/infrastructure/db/schema/prospects";
import { enrollment, sequence, stepMessage } from "@/infrastructure/db/schema/sequences";
import { withWorkspace } from "@/infrastructure/db/tenant";
import type { Env } from "@/infrastructure/env";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { fakeFetch } from "./support/fetch";
import { holding } from "./support/registry";

const revalidateTag = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidateTag }));

/** Adapters whose answers each test decides: the real ones are tested against their providers' shapes. */
const sent = {
  email: [] as { connection: string; email: Record<string, unknown> }[],
  sms: [] as { to: string; text: string }[],
  letters: [] as { to: { lines: string[] }; pdf: Uint8Array }[],
  whatsapp: [] as { to: string; template: string; parameters: string[] }[],
  alerts: [] as { event: string; title: string }[],
};
const behaviour: { sendEmail?: () => Promise<{ externalId: string; messageId?: string }>; inbox: Record<string, unknown[]> } = { inbox: {} };
let counter = 0;

vi.mock("@/infrastructure/connectors", () => ({
  adapterOf: (kind: string) => (context: { fields: Record<string, string> }) => ({
    check: async () => ({ ok: true, detail: "ok", label: context.fields.address ?? kind }),
    ...(kind === "smtp"
      ? {
          sendEmail: async (email: Record<string, unknown>) => {
            if (behaviour.sendEmail) return behaviour.sendEmail();
            counter += 1;
            sent.email.push({ connection: context.fields.address, email });
            return { externalId: `m${counter}`, messageId: `<m${counter}@acme>` };
          },
          signalsSince: async () => behaviour.inbox[context.fields.address] ?? [],
        }
      : {}),
    ...(kind === "brevo_sms" ? { sendSms: async (sms: { to: string; text: string }) => (sent.sms.push(sms), { externalId: "s1" }) } : {}),
    ...(kind === "merci_facteur" ? { postLetter: async (letter: { to: { lines: string[] }; pdf: Uint8Array }) => (sent.letters.push(letter), { externalId: "l1" }) } : {}),
    ...(kind === "whatsapp_cloud" ? { sendTemplate: async (message: { to: string; template: string; parameters: string[] }) => (sent.whatsapp.push(message), { externalId: "w1" }) } : {}),
    ...(kind === "slack" ? { notify: async (alert: { event: string; title: string }) => void sent.alerts.push(alert) } : {}),
  }),
}));

const settings = { BETTER_AUTH_URL: "https://coldlyne.test", COLDLYNE_SECRETS_KEY: Buffer.alloc(32, 1).toString("base64") } as Env;
/** A Monday, in office hours in Paris. */
const MONDAY = new Date("2026-11-09T09:00:00Z");
const DAY_MS = 86_400_000;

const healthyDns = {
  resolveTxt: async (name: string) => (name.startsWith("_dmarc.") ? [["v=DMARC1; p=none"]] : [["v=spf1 include:mx.ovh.com ~all"]]),
  resolveMx: async () => [{ exchange: "mx.acme.fr", priority: 10 }],
  resolveCname: async () => [] as string[],
};

let db: Database;
let services: Services;
let now: Date;

beforeAll(async () => {
  db = await createTestDatabase();
  services = { db, settings, fetch: fakeFetch([]).fetch, now: () => now, dns: healthyDns };
});
beforeEach(() => {
  now = MONDAY;
  sent.email.length = sent.sms.length = sent.letters.length = sent.whatsapp.length = sent.alerts.length = 0;
  behaviour.sendEmail = undefined;
  behaviour.inbox = {};
});

const SENDER = { senderName: "NORTHWIND", senderAddress: "1 rue de la Paix, 75002 Paris" };
const FIRST_EMAIL: StepInput = { channel: "email", subject: "Bonjour {{firstName}}", body: "Une idée pour {{company}}." };

async function mailbox(workspaceId: string, userId: string, address = "ada@northwind.fr") {
  const connected = await connectWithFields(services, workspaceId, userId, "smtp", { address, smtpHost: "smtp.northwind.fr", smtpPort: "465", imapHost: "imap.northwind.fr", imapPort: "993", password: "p" });
  if (!connected.ok) throw new Error(connected.error);
  return connected.connection.id;
}

/** A company with one person per name given, each with an email on the company's domain. */
async function peopleAt(workspaceId: string, listId: string, siren: string, names: [string, string][], overrides = {}) {
  const raw = holding(siren, { dirigeants: names.map(([prenoms, nom]) => ({ type_dirigeant: "personne physique", nom, prenoms, qualite: "Président" })), ...overrides });
  await addFromRegistry(db, workspaceId, listId, [fromRegistry(raw)]);
  const everyone = await prospectsOf(db, workspaceId, listId);
  for (const found of everyone.filter((candidate) => candidate.siren === siren)) {
    await confirmContact(db, workspaceId, found.id, { kind: "email", value: `${(found.lastName as string).toLowerCase()}@${siren}.fr`, page: `https://${siren}.fr/contact` });
  }
  return (await prospectsOf(db, workspaceId, listId)).filter((candidate) => candidate.siren === siren);
}

async function campaign(steps: readonly StepInput[] = [FIRST_EMAIL], options: { names?: [string, string][]; approval?: "autonomous" | "approve_first"; mailboxes?: string[] } = {}) {
  const { workspaceId, userId } = await createTestWorkspace(db);
  await saveSettings(db, workspaceId, { ...SENDER, approval: options.approval ?? "autonomous" });
  const mailboxIds = options.mailboxes ? [] : [await mailbox(workspaceId, userId)];
  for (const address of options.mailboxes ?? []) mailboxIds.push(await mailbox(workspaceId, userId, address));
  const listId = await createList(db, workspaceId, "Holdings");
  const prospects = await peopleAt(workspaceId, listId, "900000001", options.names ?? [["Jeanne", "Martin"]]);
  const created = await createSequence(services, workspaceId, userId, { name: "Holdings", steps });
  if (!created.ok) throw new Error(created.error);
  await enroll(db, workspaceId, created.id, prospects.map((found) => found.id), now);
  return { workspaceId, userId, listId, prospects, sequenceId: created.id, mailboxIds };
}

async function launched(steps?: readonly StepInput[], options?: Parameters<typeof campaign>[1]) {
  const made = await campaign(steps, options);
  const launch = await launchSequence(services, made.workspaceId, made.sequenceId, "member");
  if (!launch.ok) throw new Error(launch.problems.join(" "));
  return made;
}

const enrollmentsOf = (workspaceId: string) => withWorkspace(db, workspaceId, (tx) => tx.select().from(enrollment));
const messagesOf = (workspaceId: string) => withWorkspace(db, workspaceId, (tx) => tx.select().from(stepMessage));
const inHours = (hours: number) => new Date(MONDAY.getTime() + hours * 3_600_000);
const afterDays = (days: number) => new Date(MONDAY.getTime() + days * DAY_MS);

const reply = (address: string, overrides = {}) => ({ type: "replied" as const, channel: "email" as const, externalId: `r-${crypto.randomUUID()}`, address, at: now, detail: "Volontiers", ...overrides });

describe("launching", () => {
  it("sends nothing while it's a draft", async () => {
    const { workspaceId } = await campaign();
    expect((await tickWorkspace(services, workspaceId)).sent).toBe(0);
    expect(sent.email).toEqual([]);
    expect(await workspacesWithDueWork(db, now)).not.toContain(workspaceId);
  });

  it("is refused without a sender: the law asks each message to name one", async () => {
    const { workspaceId, sequenceId } = await campaign();
    await saveSettings(db, workspaceId, { senderName: null });
    const launch = await launchSequence(services, workspaceId, sequenceId, "member");
    expect(launch).toMatchObject({ ok: false, problems: [expect.stringContaining("expéditeur")] });
  });

  it("is refused with no steps, nobody on it, or nothing to send through", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    await saveSettings(db, workspaceId, SENDER);
    const empty = await createSequence(services, workspaceId, userId, { name: "Vide", steps: [] });
    if (!empty.ok) throw new Error(empty.error);
    expect(await launchProblems(services, workspaceId, empty.id)).toEqual([expect.stringContaining("aucune étape"), expect.stringContaining("Personne")]);
    const noMailbox = await createSequence(services, workspaceId, userId, { name: "Sans boîte", steps: [FIRST_EMAIL] });
    if (!noMailbox.ok) throw new Error(noMailbox.error);
    expect(await launchProblems(services, workspaceId, noMailbox.id)).toContainEqual(expect.stringContaining("une boîte"));
    expect(await launchProblems(services, workspaceId, crypto.randomUUID())).toEqual(["Cette séquence n’existe pas."]);
  });

  it("is refused while the sending domain isn't ready", async () => {
    const { workspaceId, sequenceId } = await campaign();
    const bare = { ...services, dns: { ...healthyDns, resolveTxt: async () => [] as string[][] } };
    expect(await launchProblems(bare, workspaceId, sequenceId)).toEqual([expect.stringContaining("northwind.fr n’est pas prêt (SPF, DMARC)")]);
  });

  it("says so when DNS can't be read, rather than wave it through", async () => {
    const { workspaceId, sequenceId } = await campaign();
    const down = { ...services, dns: { ...healthyDns, resolveTxt: async () => Promise.reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })) } };
    expect(await launchProblems(down, workspaceId, sequenceId)).toEqual([expect.stringContaining("Impossible de lire le DNS")]);
  });

  it("from an assistant only asks, where the workspace approves first", async () => {
    const { workspaceId, sequenceId } = await campaign([FIRST_EMAIL], { approval: "approve_first" });
    expect(await launchSequence(services, workspaceId, sequenceId, "assistant")).toEqual({ ok: true, status: "pending_approval" });
    expect((await tickWorkspace(services, workspaceId)).queued).toBe(0);
    expect(await launchSequence(services, workspaceId, sequenceId, "member")).toEqual({ ok: true, status: "running" });
    expect((await tickWorkspace(services, workspaceId)).queued).toBe(1);
  });

  it("from an assistant runs at once where the workspace lets it", async () => {
    const { workspaceId, sequenceId } = await campaign();
    expect(await launchSequence(services, workspaceId, sequenceId, "assistant")).toEqual({ ok: true, status: "running" });
  });
});

describe("sending an email", () => {
  it("writes to the person, with who writes, why, where the data comes from and a way out", async () => {
    const { workspaceId } = await launched();
    expect(await tickWorkspace(services, workspaceId)).toMatchObject({ sent: 1, failed: 0 });
    const { email } = sent.email[0];
    expect(email).toMatchObject({ to: "martin@900000001.fr", subject: "Bonjour Jeanne" });
    expect(email.text).toContain("Une idée pour ACME HOLDING.");
    expect(email.text).toContain("vous dirigez ACME HOLDING");
    expect(email.text).toContain("registre national des entreprises");
    expect(email.text).toContain("https://900000001.fr/contact");
    expect(email.text).toContain("NORTHWIND, 1 rue de la Paix");
    const url = unsubscribeUrl(settings, workspaceId, "martin@900000001.fr");
    expect(email.text).toContain(url);
    expect(email.headers).toEqual({ "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
  });

  it("remembers it: who was written to, from where, what it was", async () => {
    const { workspaceId, mailboxIds } = await launched();
    await tickWorkspace(services, workspaceId);
    const [row] = await withWorkspace(db, workspaceId, (tx) => tx.select().from(outreach));
    expect(row).toMatchObject({ address: "martin@900000001.fr", connectionId: mailboxIds[0], channel: "email", messageId: expect.stringContaining("@acme") });
    const [message] = await messagesOf(workspaceId);
    expect(message).toMatchObject({ status: "sent", connectionId: mailboxIds[0], attempts: 1, subject: "Bonjour Jeanne", body: "Une idée pour ACME HOLDING." });
    const [person] = await enrollmentsOf(workspaceId);
    expect(person).toMatchObject({ status: "finished", lastPosition: 0, mailboxId: mailboxIds[0], nextDueAt: null });
  });

  it("waits its turn for the next step, then follows up in the same thread", async () => {
    const { workspaceId } = await launched([FIRST_EMAIL, { channel: "email", waitDays: 3, body: "Je me permets de relancer." }]);
    await tickWorkspace(services, workspaceId);
    const [waiting] = await enrollmentsOf(workspaceId);
    expect(waiting.nextDueAt).toEqual(afterDays(3));
    expect((await tickWorkspace(services, workspaceId)).sent).toBe(0);
    now = afterDays(3);
    expect((await tickWorkspace(services, workspaceId)).sent).toBe(1);
    const follow = sent.email[1].email;
    expect(follow.subject).toBe("Re: Bonjour Jeanne");
    expect(follow.inReplyTo).toBe(`<m${counter - 1}@acme>`);
    expect(follow.references).toEqual([follow.inReplyTo]);
  });

  it("doesn't send outside its window, and picks up when it opens", async () => {
    const { workspaceId } = await launched();
    now = new Date("2026-11-09T19:00:00Z");
    expect((await tickWorkspace(services, workspaceId)).sent).toBe(0);
    now = new Date("2026-11-14T10:00:00Z");
    expect((await tickWorkspace(services, workspaceId)).sent).toBe(0);
    now = new Date("2026-11-16T09:00:00Z");
    expect((await tickWorkspace(services, workspaceId)).sent).toBe(1);
  });

  it("stops when the sequence is paused, and resumes where it was", async () => {
    const { workspaceId, sequenceId } = await launched();
    expect(await setPaused(db, workspaceId, sequenceId, true)).toBe(true);
    expect((await tickWorkspace(services, workspaceId)).sent).toBe(0);
    expect(await setPaused(db, workspaceId, sequenceId, true)).toBe(false);
    expect(await setPaused(db, workspaceId, sequenceId, false)).toBe(true);
    expect((await tickWorkspace(services, workspaceId)).sent).toBe(1);
  });

  it("runs over every workspace with something due, and says so", async () => {
    const { workspaceId } = await launched();
    expect(await workspacesWithDueWork(db, now)).toContain(workspaceId);
    const result = await runScheduler(services);
    expect(result.sent).toBeGreaterThanOrEqual(1);
    expect(sent.email.some(({ email }) => email.to === "martin@900000001.fr")).toBe(true);
  });
});

describe("when there's anything to run for", () => {
  /** Runs share a database here: each test looks at its own sequence, and clears what others left running. */
  const statusOf = async (workspaceId: string, sequenceId: string) => (await sequenceOf(db, workspaceId, sequenceId))?.status;
  const sequenceRunning = async () => (await whatIsScheduled(db)).sending;
  beforeEach(async () => {
    await db.update(sequence).set({ status: "finished" }).where(eq(sequence.status, "running"));
  });

  it("is only while a sequence is running: not a draft, nor one on pause", async () => {
    const { workspaceId, sequenceId } = await campaign();
    expect(await sequenceRunning()).toBe(false);
    await launchSequence(services, workspaceId, sequenceId, "member");
    expect(await sequenceRunning()).toBe(true);
    await setPaused(db, workspaceId, sequenceId, true);
    expect(await sequenceRunning()).toBe(false);
    await setPaused(db, workspaceId, sequenceId, false);
    expect(await sequenceRunning()).toBe(true);
  });

  it("isn't a sequence that only asked to launch", async () => {
    const { workspaceId, sequenceId } = await campaign([FIRST_EMAIL], { approval: "approve_first" });
    await launchSequence(services, workspaceId, sequenceId, "assistant");
    expect(await sequenceRunning()).toBe(false);
  });

  it("is told at once when a sequence starts, pauses, resumes or runs out of people", async () => {
    const clearedBy = async (change: () => Promise<unknown>) => {
      revalidateTag.mockClear();
      await change();
      return revalidateTag.mock.calls.length;
    };
    const { workspaceId, listId, sequenceId } = await campaign([FIRST_EMAIL]);
    expect(await clearedBy(() => launchSequence(services, workspaceId, sequenceId, "member"))).toBe(1);
    expect(await clearedBy(() => setPaused(db, workspaceId, sequenceId, true))).toBe(1);
    expect(await clearedBy(() => setPaused(db, workspaceId, sequenceId, false))).toBe(1);
    expect(await clearedBy(() => runScheduler(services))).toBe(1);
    expect(await clearedBy(() => runScheduler(services))).toBe(0);
    const late = await peopleAt(workspaceId, listId, "900000003", [["Luc", "Petit"]]);
    expect(await clearedBy(() => enroll(db, workspaceId, sequenceId, late.map((found) => found.id), now))).toBe(1);
  });

  it("ends when nobody is left on it", async () => {
    const { workspaceId, sequenceId } = await launched();
    await runScheduler(services);
    expect(await statusOf(workspaceId, sequenceId)).toBe("finished");
    expect(await sequenceRunning()).toBe(false);
  });

  it("goes on while someone waits, for their date or for a member", async () => {
    const waiting = await launched([FIRST_EMAIL, { channel: "email", waitDays: 3, body: "Relance" }]);
    await runScheduler(services);
    expect(await statusOf(waiting.workspaceId, waiting.sequenceId)).toBe("running");
    const task = await launched([{ channel: "linkedin", body: "Bonjour" }], { names: [["Luc", "Petit"]] });
    await confirmContact(db, task.workspaceId, task.prospects[0].id, { kind: "linkedin", value: "https://linkedin.com/in/luc", page: "https://x.fr" });
    await tickWorkspace(services, task.workspaceId);
    expect(await finishEmptiedSequences(db)).toBe(0);
    expect(await statusOf(task.workspaceId, task.sequenceId)).toBe("running");
  });

  it("ends for a sequence whose people all stopped, even with nothing due", async () => {
    const { workspaceId, sequenceId } = await launched();
    const [row] = await enrollmentsOf(workspaceId);
    await removeFromSequence(db, workspaceId, row.id);
    expect(await finishEmptiedSequences(db)).toBe(1);
    expect(await statusOf(workspaceId, sequenceId)).toBe("finished");
  });

  it("starts again when someone joins a finished sequence, and they get their step", async () => {
    const made = await launched();
    await runScheduler(services);
    expect(await statusOf(made.workspaceId, made.sequenceId)).toBe("finished");
    const late = await peopleAt(made.workspaceId, made.listId, "900000002", [["Luc", "Petit"]]);
    expect(await enroll(db, made.workspaceId, made.sequenceId, late.map((found) => found.id), now)).toMatchObject({ enrolled: 1 });
    expect(await statusOf(made.workspaceId, made.sequenceId)).toBe("running");
    expect((await tickWorkspace(services, made.workspaceId)).sent).toBe(1);
  });

  it("doesn't start again if nobody could join", async () => {
    const made = await launched();
    await runScheduler(services);
    expect(await enroll(db, made.workspaceId, made.sequenceId, made.prospects.map((found) => found.id), now)).toMatchObject({ enrolled: 0 });
    expect(await statusOf(made.workspaceId, made.sequenceId)).toBe("finished");
  });
});

describe("what a mailbox may send", () => {
  const many = (count: number): [string, string][] => Array.from({ length: count }, (_, index) => ["Jeanne", `Martin${index}`]);

  it("sends a few at a time, however many are due", async () => {
    const { workspaceId } = await launched([FIRST_EMAIL], { names: many(6) });
    // Late in the window, so what's left has to go faster than one per run; still never a burst.
    now = new Date("2026-11-09T16:30:00Z");
    expect((await tickWorkspace(services, workspaceId)).sent).toBe(3);
    now = new Date("2026-11-09T16:45:00Z");
    expect((await tickWorkspace(services, workspaceId)).sent).toBeLessThanOrEqual(3);
  });

  it("holds to a new mailbox's limit for the day, and goes on the next", async () => {
    const { workspaceId, mailboxIds } = await launched([FIRST_EMAIL], { names: many(4) });
    for (let index = 0; index < 10; index++) await recordOutreach(db, workspaceId, { connectionId: mailboxIds[0], channel: "email", address: `past${index}@acme.fr`, at: inHours(-1) });
    expect((await tickWorkspace(services, workspaceId)).sent).toBe(0);
    now = afterDays(1);
    expect((await tickWorkspace(services, workspaceId)).sent).toBeGreaterThan(0);
  });

  it("shares people among its mailboxes, and keeps each thread in one", async () => {
    const { workspaceId, mailboxIds } = await launched([FIRST_EMAIL, { channel: "email", waitDays: 1, body: "Relance" }], { names: many(4), mailboxes: ["a@northwind.fr", "b@northwind.fr"] });
    now = new Date("2026-11-09T16:45:00Z");
    await tickWorkspace(services, workspaceId);
    const first = sent.email.map(({ connection: from }) => from);
    expect(new Set(first)).toEqual(new Set(["a@northwind.fr", "b@northwind.fr"]));
    const chosen = new Map((await enrollmentsOf(workspaceId)).filter((row) => row.mailboxId).map((row) => [row.id, row.mailboxId]));
    expect(new Set(chosen.values())).toEqual(new Set(mailboxIds));
    sent.email.length = 0;
    now = new Date("2026-11-10T16:45:00Z");
    await tickWorkspace(services, workspaceId);
    const after = new Map((await enrollmentsOf(workspaceId)).filter((row) => row.mailboxId).map((row) => [row.id, row.mailboxId]));
    for (const [id, mailboxId] of chosen) expect(after.get(id)).toBe(mailboxId);
  });

  it("keeps someone waiting on their own mailbox rather than switch threads", async () => {
    const { workspaceId, mailboxIds } = await launched([FIRST_EMAIL, { channel: "email", waitDays: 1, body: "Relance" }], { mailboxes: ["a@northwind.fr", "b@northwind.fr"] });
    await tickWorkspace(services, workspaceId);
    const [row] = await enrollmentsOf(workspaceId);
    await withWorkspace(db, workspaceId, (tx) => tx.update(connection).set({ pausedAt: now, pausedReason: "Test" }).where(eq(connection.id, row.mailboxId as string)));
    now = afterDays(1);
    expect((await tickWorkspace(services, workspaceId)).sent).toBe(0);
    expect(mailboxIds).toContain(row.mailboxId);
  });
});

describe("a reply", () => {
  it("is read before anything goes out, and stops the next message", async () => {
    const { workspaceId, prospects } = await launched([FIRST_EMAIL, { channel: "email", waitDays: 1, body: "Relance" }]);
    await tickWorkspace(services, workspaceId);
    behaviour.inbox["ada@northwind.fr"] = [reply("martin@900000001.fr")];
    now = afterDays(1);
    expect((await tickWorkspace(services, workspaceId)).sent).toBe(0);
    expect(sent.email).toHaveLength(1);
    const [row] = await enrollmentsOf(workspaceId);
    expect(row).toMatchObject({ status: "stopped", stopReason: "replied", nextDueAt: null });
    const [state] = await withWorkspace(db, workspaceId, (tx) => tx.select({ state: prospect.state }).from(prospect).where(eq(prospect.id, prospects[0].id)));
    expect(state.state).toBe("replied");
  });

  it("stops everyone else at the same company, on any sequence", async () => {
    const { workspaceId, mailboxIds } = await launched([FIRST_EMAIL, { channel: "email", waitDays: 1, body: "Relance" }], { names: [["Jeanne", "Martin"], ["Paul", "Durand"]] });
    now = new Date("2026-11-09T16:45:00Z");
    await tickWorkspace(services, workspaceId);
    expect(sent.email).toHaveLength(2);
    await recordSignals(db, workspaceId, mailboxIds[0], [reply("martin@900000001.fr")]);
    const rows = await enrollmentsOf(workspaceId);
    expect(rows.map((row) => row.stopReason).sort()).toEqual(["colleague_replied", "replied"]);
    expect(rows.every((row) => row.status === "stopped")).toBe(true);
  });

  it("doesn't stop anyone at another company", async () => {
    const made = await launched([FIRST_EMAIL, { channel: "email", waitDays: 1, body: "Relance" }]);
    const others = await peopleAt(made.workspaceId, made.listId, "900000002", [["Luc", "Petit"]]);
    await enroll(db, made.workspaceId, made.sequenceId, others.map((found) => found.id), now);
    now = new Date("2026-11-09T16:45:00Z");
    await tickWorkspace(services, made.workspaceId);
    await recordSignals(db, made.workspaceId, made.mailboxIds[0], [reply("martin@900000001.fr")]);
    const rows = await enrollmentsOf(made.workspaceId);
    expect(rows.find((row) => row.personId !== made.prospects[0].personId)?.status).toBe("active");
  });

  it("cancels what was waiting for approval", async () => {
    const { workspaceId, mailboxIds, sequenceId } = await launched([FIRST_EMAIL, { channel: "email", waitDays: 1, body: "Relance" }], { approval: "approve_first" });
    await tickWorkspace(services, workspaceId);
    const queue = await messagesToReview(db, workspaceId, "awaiting_approval", sequenceId);
    await recordOutreach(db, workspaceId, { connectionId: mailboxIds[0], channel: "email", address: "martin@900000001.fr", enrollmentId: queue[0].enrollmentId, at: now });
    await recordSignals(db, workspaceId, mailboxIds[0], [reply("martin@900000001.fr")]);
    expect(await messagesToReview(db, workspaceId, "awaiting_approval")).toEqual([]);
    expect(await approveMessages(db, workspaceId, "x", [queue[0].id], now)).toBe(0);
  });

  it("by an auto-reply stops nothing: the person hasn't answered", async () => {
    const { workspaceId, mailboxIds } = await launched([FIRST_EMAIL, { channel: "email", waitDays: 1, body: "Relance" }]);
    await tickWorkspace(services, workspaceId);
    await recordSignals(db, workspaceId, mailboxIds[0], [reply("martin@900000001.fr", { type: "auto_reply" })]);
    const [row] = await enrollmentsOf(workspaceId);
    expect(row.status).toBe("active");
  });

  it.each(["meeting_booked", "signed_up"] as const)("%s counts as an answer too", async (type) => {
    const { workspaceId, mailboxIds } = await launched([FIRST_EMAIL, { channel: "email", waitDays: 1, body: "Relance" }]);
    await tickWorkspace(services, workspaceId);
    await recordSignals(db, workspaceId, mailboxIds[0], [reply("martin@900000001.fr", { type })]);
    const [row] = await enrollmentsOf(workspaceId);
    expect(row.stopReason).toBe("replied");
  });
});

describe("a bounce", () => {
  it("stops the sequence and the address", async () => {
    const { workspaceId, mailboxIds, prospects } = await launched([FIRST_EMAIL, { channel: "email", waitDays: 1, body: "Relance" }]);
    await tickWorkspace(services, workspaceId);
    await recordSignals(db, workspaceId, mailboxIds[0], [reply("martin@900000001.fr", { type: "bounced" })]);
    const [row] = await enrollmentsOf(workspaceId);
    expect(row).toMatchObject({ status: "stopped", stopReason: "bounced" });
    const blocked = await withWorkspace(db, workspaceId, (tx) => tx.select().from(suppression));
    expect(blocked.map((found) => found.value)).toContain("martin@900000001.fr");
    const [state] = await withWorkspace(db, workspaceId, (tx) => tx.select({ state: prospect.state }).from(prospect).where(eq(prospect.id, prospects[0].id)));
    expect(state.state).toBe("bounced");
  });

  it("leads to a step written for it, on another channel", async () => {
    const { workspaceId, mailboxIds, prospects } = await launched([FIRST_EMAIL, { channel: "email", waitDays: 1, body: "Relance" }, { channel: "linkedin", condition: "bounced", body: "Bonjour {{firstName}}, mon email n’est pas passé." }]);
    await confirmContact(db, workspaceId, prospects[0].id, { kind: "linkedin", value: "https://linkedin.com/in/jeanne", page: "https://x.fr" });
    await tickWorkspace(services, workspaceId);
    await recordSignals(db, workspaceId, mailboxIds[0], [reply("martin@900000001.fr", { type: "bounced" })]);
    expect((await tickWorkspace(services, workspaceId)).tasks).toBe(1);
    const task = (await messagesOf(workspaceId)).find((message) => message.status === "to_do");
    expect(task).toMatchObject({ channel: "linkedin", body: "Bonjour Jeanne, mon email n’est pas passé." });
    expect(sent.email).toHaveLength(1);
  });

  it("doesn't even happen at a domain that takes no mail: the message is skipped and the address kept out", async () => {
    const nowhere = { ...services, dns: { ...healthyDns, resolveMx: async () => Promise.reject(Object.assign(new Error("no"), { code: "ENOTFOUND" })) } };
    const { workspaceId } = await campaign();
    await launchSequence(services, workspaceId, (await sequencesOf(db, workspaceId))[0].id, "member");
    expect(await tickWorkspace(nowhere, workspaceId)).toMatchObject({ sent: 0, skipped: 1 });
    expect(sent.email).toEqual([]);
    const [row] = await enrollmentsOf(workspaceId);
    expect(row.stopReason).toBe("bounced");
    expect((await messagesOf(workspaceId))[0].note).toContain("ne reçoit pas d’emails");
  });
});

describe("the way out", () => {
  it("stops every channel at once, and asking twice changes nothing", async () => {
    const { workspaceId } = await launched([FIRST_EMAIL, { channel: "email", waitDays: 1, body: "Relance" }]);
    await tickWorkspace(services, workspaceId);
    const token = unsubscribeToken(settings, workspaceId, "Martin@900000001.fr");
    expect(await unsubscribeSubject(services, token)).toEqual({ sender: "NORTHWIND", address: "martin@900000001.fr" });
    expect(await unsubscribe(services, token)).toBe(true);
    const [row] = await enrollmentsOf(workspaceId);
    expect(row).toMatchObject({ status: "stopped", stopReason: "opted_out" });
    expect((await withWorkspace(db, workspaceId, (tx) => tx.select().from(suppression))).map((found) => found.reason)).toContain("opted_out");
    now = afterDays(1);
    expect(await unsubscribe(services, token)).toBe(true);
    expect((await tickWorkspace(services, workspaceId)).sent).toBe(0);
  });

  it("can't be forged", async () => {
    const { workspaceId } = await launched();
    const token = unsubscribeToken(settings, workspaceId, "martin@900000001.fr");
    expect(await unsubscribe(services, `${token.split(".")[0]}.forged`)).toBe(false);
    expect(await unsubscribe(services, "nonsense")).toBe(false);
    expect(readUnsubscribeToken({ ...settings, COLDLYNE_SECRETS_KEY: "other" }, token)).toBeNull();
    expect(await unsubscribeSubject(services, "nonsense")).toBeNull();
  });

  it("keeps someone on the list from being written to, on enrolling or at sending", async () => {
    const made = await launched();
    await withWorkspace(db, made.workspaceId, (tx) => tx.insert(suppression).values({ value: "900000001.fr", reason: "member" }));
    await tickWorkspace(services, made.workspaceId);
    expect(sent.email).toEqual([]);
    const [row] = await enrollmentsOf(made.workspaceId);
    expect(row).toMatchObject({ status: "stopped", stopReason: "suppressed" });
  });
});

describe("a mailbox that's hurting", () => {
  async function hurtingMailbox() {
    const made = await launched([FIRST_EMAIL], { names: [["Jeanne", "Martin"]] });
    const [{ id: enrollmentId }] = await enrollmentsOf(made.workspaceId);
    for (let index = 0; index < 20; index++) await recordOutreach(db, made.workspaceId, { connectionId: made.mailboxIds[0], channel: "email", address: `p${index}@acme.fr`, enrollmentId, at: inHours(-48) });
    await recordSignals(db, made.workspaceId, made.mailboxIds[0], [reply("p1@acme.fr", { type: "bounced", at: inHours(-24) })]);
    return made;
  }

  it("is paused before it hurts its domain, says why and alerts", async () => {
    const made = await hurtingMailbox();
    const slack = await connectWithFields(services, made.workspaceId, made.userId, "slack", { webhookUrl: "https://hooks.slack.test/x" });
    expect(slack.ok).toBe(true);
    await withWorkspace(db, made.workspaceId, (tx) => tx.update(enrollment).set({ status: "active", nextDueAt: now }));
    expect((await tickWorkspace(services, made.workspaceId)).sent).toBe(0);
    const [row] = await withWorkspace(db, made.workspaceId, (tx) => tx.select().from(connection).where(eq(connection.id, made.mailboxIds[0])));
    expect(row.pausedReason).toContain("Trop d’adresses refusées");
    expect(sent.alerts).toEqual([expect.objectContaining({ event: "mailbox_paused" })]);
    await tickWorkspace(services, made.workspaceId);
    expect(sent.alerts).toHaveLength(1);
  });

  it("only sends again once a member resumes it", async () => {
    const made = await hurtingMailbox();
    await withWorkspace(db, made.workspaceId, (tx) => tx.update(enrollment).set({ status: "active", nextDueAt: now }));
    await tickWorkspace(services, made.workspaceId);
    expect(sent.email).toEqual([]);
    expect(await resumeMailbox(db, made.workspaceId, made.mailboxIds[0])).toBe(true);
    const [row] = await withWorkspace(db, made.workspaceId, (tx) => tx.select().from(connection).where(eq(connection.id, made.mailboxIds[0])));
    expect(row.pausedAt).toBeNull();
    expect(await resumeMailbox(db, made.workspaceId, crypto.randomUUID())).toBe(false);
  });
});

describe("approving first", () => {
  const approved = () => launched([FIRST_EMAIL], { approval: "approve_first" });

  it("shows each message as it would go, and sends nothing", async () => {
    const { workspaceId } = await approved();
    expect(await tickWorkspace(services, workspaceId)).toMatchObject({ sent: 0, queued: 1 });
    const [queued] = await messagesToReview(db, workspaceId, "awaiting_approval");
    expect(queued).toMatchObject({ subject: "Bonjour Jeanne", body: "Une idée pour ACME HOLDING.", person: "Jeanne Martin", company: "ACME HOLDING", sequence: "Holdings" });
    expect((await tickWorkspace(services, workspaceId)).queued).toBe(0);
    expect(sent.email).toEqual([]);
  });

  it("sends what's approved, within its caps, and remembers who approved", async () => {
    const { workspaceId, userId } = await approved();
    await tickWorkspace(services, workspaceId);
    const [queued] = await messagesToReview(db, workspaceId, "awaiting_approval");
    expect(await approveMessages(db, workspaceId, userId, [queued.id], now)).toBe(1);
    expect((await tickWorkspace(services, workspaceId)).sent).toBe(1);
    expect((await messagesOf(workspaceId))[0]).toMatchObject({ status: "sent", approvedBy: userId });
    expect(await approveMessages(db, workspaceId, userId, [], now)).toBe(0);
  });

  it("asks again when the words change", async () => {
    const { workspaceId, userId } = await approved();
    await tickWorkspace(services, workspaceId);
    const [queued] = await messagesToReview(db, workspaceId, "awaiting_approval");
    await approveMessages(db, workspaceId, userId, [queued.id], now);
    await writeMessage(db, workspaceId, { enrollmentId: queued.enrollmentId, stepId: queued.stepId as string }, { body: "Autre texte" }, "assistant", now);
    expect((await tickWorkspace(services, workspaceId)).sent).toBe(0);
    expect((await messagesToReview(db, workspaceId, "awaiting_approval"))[0].body).toBe("Autre texte");
  });
});

describe("what a message says", () => {
  it("uses what an assistant wrote for this person over the step's text", async () => {
    const { workspaceId, sequenceId } = await launched();
    const [row] = await enrollmentsOf(workspaceId);
    const found = await sequenceOf(db, workspaceId, sequenceId);
    await writeMessage(db, workspaceId, { enrollmentId: row.id, stepId: found!.steps[0].id }, { subject: "Pour vous", body: "Écrit pour {{firstName}}." }, "assistant", now);
    await tickWorkspace(services, workspaceId);
    expect(sent.email[0].email.subject).toBe("Pour vous");
    expect(sent.email[0].email.text).toContain("Écrit pour Jeanne.");
    expect((await messagesOf(workspaceId))[0].writtenBy).toBe("assistant");
  });

  it("can't be changed once it has left, or empty, or for someone not on that sequence", async () => {
    const { workspaceId, sequenceId } = await launched();
    const [row] = await enrollmentsOf(workspaceId);
    const found = await sequenceOf(db, workspaceId, sequenceId);
    const target = { enrollmentId: row.id, stepId: found!.steps[0].id };
    expect((await writeMessage(db, workspaceId, target, { body: " " }, "member", now)).ok).toBe(false);
    expect((await writeMessage(db, workspaceId, { ...target, stepId: crypto.randomUUID() }, { body: "x" }, "member", now)).ok).toBe(false);
    await tickWorkspace(services, workspaceId);
    expect(await writeMessage(db, workspaceId, target, { body: "Trop tard" }, "member", now)).toEqual({ ok: false, error: "Ce message est déjà parti." });
  });

  it("is never sent with a hole in it: a member corrects it, and it goes", async () => {
    const { workspaceId, sequenceId } = await launched([{ channel: "email", subject: "Bonjour", body: "Bonjour {{inconnu}}" }]);
    expect(await tickWorkspace(services, workspaceId)).toMatchObject({ sent: 0, failed: 1 });
    const [failed] = await messagesToReview(db, workspaceId, "failed", sequenceId);
    expect(failed.note).toContain("inconnu");
    expect((await tickWorkspace(services, workspaceId)).sent).toBe(0);
    await writeMessage(db, workspaceId, { enrollmentId: failed.enrollmentId, stepId: failed.stepId as string }, { body: "Bonjour" }, "member", now);
    expect((await tickWorkspace(services, workspaceId)).sent).toBe(1);
  });
});

describe("a provider that fails", () => {
  it("is tried again, three times, then a person looks", async () => {
    const { workspaceId } = await launched();
    behaviour.sendEmail = async () => Promise.reject(new Error("Serveur indisponible"));
    expect((await tickWorkspace(services, workspaceId)).failed).toBe(1);
    expect((await messagesOf(workspaceId))[0]).toMatchObject({ status: "draft", attempts: 1, note: "Serveur indisponible" });
    await tickWorkspace(services, workspaceId);
    await tickWorkspace(services, workspaceId);
    const [failed] = await messagesOf(workspaceId);
    expect(failed).toMatchObject({ status: "failed", attempts: 3 });
    expect((await enrollmentsOf(workspaceId))[0].status).toBe("waiting_member");
    behaviour.sendEmail = undefined;
    expect((await tickWorkspace(services, workspaceId)).sent).toBe(0);
    expect(await retryMessage(db, workspaceId, failed.id, now)).toBe(true);
    expect((await tickWorkspace(services, workspaceId)).sent).toBe(1);
    expect(await retryMessage(db, workspaceId, failed.id, now)).toBe(false);
  });

  it("whose run crashed mid-send isn't sent again: a person checks, after an hour", async () => {
    const { workspaceId } = await launched();
    await tickWorkspace(services, workspaceId);
    await withWorkspace(db, workspaceId, (tx) => tx.update(stepMessage).set({ status: "sending", updatedAt: inHours(-2) }));
    await withWorkspace(db, workspaceId, (tx) => tx.update(enrollment).set({ status: "active", nextDueAt: now, lastPosition: -1 }));
    sent.email.length = 0;
    await tickWorkspace(services, workspaceId);
    expect(sent.email).toEqual([]);
    expect((await messagesOf(workspaceId))[0]).toMatchObject({ status: "failed", note: expect.stringContaining("interrompu") });
  });
});

describe("the other channels", () => {
  async function withProviders(steps: readonly StepInput[], overrides = {}) {
    const { workspaceId, userId } = await createTestWorkspace(db);
    await saveSettings(db, workspaceId, SENDER);
    const sms = await connectWithFields(services, workspaceId, userId, "brevo_sms", { apiKey: "k", sender: "NORTHWIND" });
    const letters = await connectWithFields(services, workspaceId, userId, "merci_facteur", { serviceId: "s", secretKey: "k", userId: "u" });
    const whatsapp = await connectWithFields(services, workspaceId, userId, "whatsapp_cloud", { phoneNumberId: "p", businessAccountId: "b", accessToken: "t", appSecret: "a" });
    expect([sms.ok, letters.ok, whatsapp.ok]).toEqual([true, true, true]);
    const listId = await createList(db, workspaceId, "Liste");
    const prospects = await peopleAt(workspaceId, listId, "900000001", [["Jeanne", "Martin"]], overrides);
    await confirmContact(db, workspaceId, prospects[0].id, { kind: "phone", value: "+33612345678", page: "https://x.fr" });
    const created = await createSequence(services, workspaceId, userId, { name: "Canaux", steps });
    if (!created.ok) throw new Error(created.error);
    await enroll(db, workspaceId, created.id, prospects.map((found) => found.id), now);
    const launch = await launchSequence(services, workspaceId, created.id, "member");
    expect(launch).toMatchObject({ ok: true });
    return { workspaceId, userId, prospects };
  }

  it("sends an SMS, naming the sender", async () => {
    const { workspaceId } = await withProviders([{ channel: "sms", body: "Bonjour {{firstName}}" }]);
    await tickWorkspace(services, workspaceId);
    expect(sent.sms).toEqual([{ to: "+33612345678", text: "NORTHWIND : Bonjour Jeanne" }]);
  });

  it("posts a letter to the registered office, as a PDF", async () => {
    const { workspaceId } = await withProviders([{ channel: "letter", body: "Madame, {{company}} nous intéresse." }], { siege: { numero_voie: "12", type_voie: "RUE", libelle_voie: "DE LA REPUBLIQUE", code_postal: "69002", libelle_commune: "LYON" } });
    await tickWorkspace(services, workspaceId);
    expect(sent.letters[0].to).toMatchObject({ name: "Jeanne Martin", company: "ACME HOLDING", lines: ["12 RUE DE LA REPUBLIQUE"], postcode: "69002", city: "LYON" });
    expect(Buffer.from(sent.letters[0].pdf).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("skips a letter without a street, and carries on", async () => {
    const { workspaceId } = await withProviders([{ channel: "letter", body: "Madame" }, { channel: "sms", body: "Bonjour" }]);
    expect(await tickWorkspace(services, workspaceId)).toMatchObject({ skipped: 1, sent: 1 });
    expect((await messagesOf(workspaceId)).find((message) => message.channel === "letter")?.note).toContain("adresse postale");
    expect(sent.sms).toHaveLength(1);
  });

  it("uses WhatsApp's API only for someone who agreed, otherwise leaves it to a member", async () => {
    const step: StepInput = { channel: "whatsapp", body: "Bonjour", options: { template: "premier_contact", language: "fr", parameters: ["{{firstName}}"] } };
    const refused = await withProviders([step]);
    expect(await tickWorkspace(services, refused.workspaceId)).toMatchObject({ sent: 0, tasks: 1 });
    expect(sent.whatsapp).toEqual([]);
    const agreed = await withProviders([step]);
    await recordWhatsappConsent(db, agreed.workspaceId, agreed.prospects[0].id, true, now);
    await tickWorkspace(services, agreed.workspaceId);
    expect(sent.whatsapp).toEqual([{ to: "+33612345678", template: "premier_contact", language: "fr", parameters: ["Jeanne"] }]);
  });

  it("leaves WhatsApp to a member when the step has no approved template", async () => {
    const { workspaceId, prospects } = await withProviders([{ channel: "whatsapp", body: "Bonjour" }]);
    await recordWhatsappConsent(db, workspaceId, prospects[0].id, true, now);
    expect((await tickWorkspace(services, workspaceId)).tasks).toBe(1);
  });
});

describe("someone with no address on a channel", () => {
  it("skips that step and moves on, on the same run when nothing's to wait for", async () => {
    const { workspaceId } = await launched([{ channel: "call", body: "Bonjour" }, FIRST_EMAIL]);
    expect(await tickWorkspace(services, workspaceId)).toMatchObject({ skipped: 1, sent: 1 });
    expect((await messagesOf(workspaceId)).find((message) => message.channel === "call")).toMatchObject({ status: "skipped", note: "Pas de numéro de téléphone" });
  });

  it("waits for the step after, when it has a delay", async () => {
    const { workspaceId } = await launched([{ channel: "linkedin", body: "Bonjour" }, { ...FIRST_EMAIL, waitDays: 2 }]);
    expect(await tickWorkspace(services, workspaceId)).toMatchObject({ skipped: 1, sent: 0 });
    expect((await enrollmentsOf(workspaceId))[0].nextDueAt).toEqual(afterDays(2));
  });

  it("finishes when none is left", async () => {
    const { workspaceId } = await launched([{ channel: "linkedin", body: "Bonjour" }]);
    await tickWorkspace(services, workspaceId);
    expect((await enrollmentsOf(workspaceId))[0].status).toBe("finished");
  });
});

describe("changing a sequence while it runs", () => {
  it("rewrites what hasn't left, approved or not; what's written for one person stays", async () => {
    const { workspaceId, userId, sequenceId } = await launched([FIRST_EMAIL], { approval: "approve_first", names: [["Jeanne", "Martin"], ["Paul", "Durand"]] });
    await tickWorkspace(services, workspaceId);
    const queue = await messagesToReview(db, workspaceId, "awaiting_approval");
    expect(queue).toHaveLength(2);
    await writeMessage(db, workspaceId, { enrollmentId: queue[0].enrollmentId, stepId: queue[0].stepId as string }, { body: "Sur mesure" }, "assistant", now);
    await approveMessages(db, workspaceId, userId, [queue[1].id], now);
    const step = (await sequenceOf(db, workspaceId, sequenceId))!.steps[0];
    expect(await updateStep(db, workspaceId, step.id, { body: "Nouveau texte pour {{company}}" })).toEqual({ ok: true });
    await withWorkspace(db, workspaceId, (tx) => tx.update(enrollment).set({ status: "active", nextDueAt: now }));
    await tickWorkspace(services, workspaceId);
    const after = await messagesToReview(db, workspaceId, "awaiting_approval");
    expect(after.map((message) => message.body).sort()).toEqual(["Nouveau texte pour ACME HOLDING", "Sur mesure"]);
  });

  it("refuses a step it couldn't send", async () => {
    const { workspaceId, sequenceId } = await launched();
    const step = (await sequenceOf(db, workspaceId, sequenceId))!.steps[0];
    expect((await updateStep(db, workspaceId, step.id, { body: " " })).ok).toBe(false);
    expect((await updateStep(db, workspaceId, crypto.randomUUID(), { body: "x" })).ok).toBe(false);
    expect((await addStep(db, workspaceId, sequenceId, { channel: "pigeon" as "email", body: "x" })).ok).toBe(false);
    expect((await addStep(db, workspaceId, crypto.randomUUID(), { channel: "email", body: "x" })).ok).toBe(false);
  });

  it("adds a step for those who haven't passed that point, and not again for those who have", async () => {
    const { workspaceId, sequenceId } = await launched([FIRST_EMAIL, { channel: "email", waitDays: 2, body: "Dernière" }]);
    await tickWorkspace(services, workspaceId);
    await addStep(db, workspaceId, sequenceId, { channel: "email", waitDays: 1, body: "Glissée" }, 0);
    const { steps } = (await sequenceOf(db, workspaceId, sequenceId))!;
    expect(steps.map((step) => [step.position, step.body])).toEqual([[0, "Une idée pour {{company}}."], [1, "Glissée"], [2, "Dernière"]]);
    now = afterDays(2);
    await tickWorkspace(services, workspaceId);
    expect(sent.email[1].email.text).toContain("Glissée");
    await addStep(db, workspaceId, sequenceId, { channel: "email", waitDays: 0, body: "À la fin" });
    expect((await sequenceOf(db, workspaceId, sequenceId))!.steps.at(-1)?.position).toBe(3);
  });

  it("removes a step: what it sent stays on record, and whoever waited on it moves on", async () => {
    const { workspaceId, sequenceId, prospects } = await launched([{ channel: "linkedin", body: "Bonjour" }, FIRST_EMAIL]);
    await confirmContact(db, workspaceId, prospects[0].id, { kind: "linkedin", value: "https://linkedin.com/in/jeanne", page: "https://x.fr" });
    await tickWorkspace(services, workspaceId);
    expect((await enrollmentsOf(workspaceId))[0].status).toBe("waiting_member");
    const step = (await sequenceOf(db, workspaceId, sequenceId))!.steps[0];
    expect(await removeStep(db, workspaceId, step.id, now)).toBe(true);
    expect((await enrollmentsOf(workspaceId))[0].status).toBe("active");
    expect((await tickWorkspace(services, workspaceId)).sent).toBe(1);
    expect(await removeStep(db, workspaceId, crypto.randomUUID(), now)).toBe(false);
  });

  it("changes its window and what it sends through, and refuses what wouldn't work", async () => {
    const { workspaceId, sequenceId, mailboxIds } = await launched();
    expect(await updateSequence(services, workspaceId, sequenceId, { name: "Renommée", window: { days: [6], from: "09:00", to: "18:00", timezone: "Europe/Paris" } })).toEqual({ ok: true });
    expect((await tickWorkspace(services, workspaceId)).sent).toBe(0);
    expect((await updateSequence(services, workspaceId, sequenceId, { window: { days: [], from: "09:00", to: "18:00", timezone: "Europe/Paris" } })).ok).toBe(false);
    expect((await updateSequence(services, workspaceId, sequenceId, { channels: { email: [crypto.randomUUID()] } })).ok).toBe(false);
    expect(await updateSequence(services, workspaceId, sequenceId, { channels: { email: mailboxIds } })).toEqual({ ok: true });
    expect((await updateSequence(services, workspaceId, crypto.randomUUID(), { name: "x" })).ok).toBe(false);
    expect((await sequencesOf(db, workspaceId))[0].name).toBe("Renommée");
  });
});

describe("creating a sequence", () => {
  it("refuses a nameless one, an impossible step or window, and a connection that can't do it", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const create = (input: Partial<Parameters<typeof createSequence>[3]>) => createSequence(services, workspaceId, userId, { name: "S", steps: [FIRST_EMAIL], ...input });
    expect((await create({ name: " " })).ok).toBe(false);
    expect((await create({ steps: [{ channel: "email", body: " " }] })).ok).toBe(false);
    expect((await create({ steps: [{ ...FIRST_EMAIL, waitDays: -1 }] })).ok).toBe(false);
    expect((await create({ steps: [{ ...FIRST_EMAIL, condition: "nope" as "always" }] })).ok).toBe(false);
    expect((await create({ window: { days: [], from: "09:00", to: "18:00", timezone: "Europe/Paris" } })).ok).toBe(false);
    expect((await create({ channels: { email: [crypto.randomUUID()] } })).ok).toBe(false);
  });

  it("sends through everything connected unless told otherwise", async () => {
    const { workspaceId, sequenceId, mailboxIds } = await campaign([FIRST_EMAIL], { mailboxes: ["a@northwind.fr", "b@northwind.fr"] });
    expect((await sequenceOf(db, workspaceId, sequenceId))!.channels.email?.sort()).toEqual([...mailboxIds].sort());
  });
});

describe("who can be put on a sequence", () => {
  it("leaves out whoever is already on one, has answered or is excluded, and says why", async () => {
    const made = await campaign();
    expect(await enroll(db, made.workspaceId, made.sequenceId, made.prospects.map((found) => found.id), now)).toMatchObject({ enrolled: 0, skipped: [{ why: expect.stringContaining("déjà sur cette séquence") }] });
    const other = await createSequence(services, made.workspaceId, made.userId, { name: "Autre", steps: [FIRST_EMAIL] });
    if (!other.ok) throw new Error(other.error);
    expect(await enroll(db, made.workspaceId, other.id, made.prospects.map((found) => found.id), now)).toMatchObject({ enrolled: 0, skipped: [{ why: expect.stringContaining("autre séquence") }] });
    const blocked = await peopleAt(made.workspaceId, made.listId, "900000002", [["Luc", "Petit"]]);
    await withWorkspace(db, made.workspaceId, (tx) => tx.insert(suppression).values({ value: "900000002.fr", reason: "member" }));
    expect(await enroll(db, made.workspaceId, other.id, blocked.map((found) => found.id), now)).toMatchObject({ skipped: [{ why: expect.stringContaining("liste d’exclusion") }] });
    const answered = await peopleAt(made.workspaceId, made.listId, "900000003", [["Eve", "Roux"]]);
    await withWorkspace(db, made.workspaceId, (tx) => tx.update(prospect).set({ state: "replied" }).where(eq(prospect.id, answered[0].id)));
    expect(await enroll(db, made.workspaceId, other.id, answered.map((found) => found.id), now)).toMatchObject({ skipped: [{ why: expect.stringContaining("déjà répondu") }] });
    expect(await enroll(db, made.workspaceId, crypto.randomUUID(), [], now)).toBeNull();
    expect(await enroll(db, made.workspaceId, other.id, [], now)).toEqual({ enrolled: 0, skipped: [] });
  });

  it("leaves out a colleague of someone who answered or refused, on any later sequence", async () => {
    const made = await launched([FIRST_EMAIL], { names: [["Jeanne", "Martin"], ["Paul", "Durand"]] });
    now = new Date("2026-11-09T16:45:00Z");
    await tickWorkspace(services, made.workspaceId);
    await recordSignals(db, made.workspaceId, made.mailboxIds[0], [reply("martin@900000001.fr")]);
    const later = await createSequence(services, made.workspaceId, made.userId, { name: "Plus tard", steps: [FIRST_EMAIL] });
    if (!later.ok) throw new Error(later.error);
    const colleague = made.prospects.find((found) => (found.lastName as string).toLowerCase() === "durand") as (typeof made.prospects)[number];
    expect((await sequencesOf(db, made.workspaceId)).find((found) => found.id === made.sequenceId)?.replied).toBe(1);
    expect(await enroll(db, made.workspaceId, later.id, [colleague.id], now)).toMatchObject({ enrolled: 0, skipped: [{ why: expect.stringContaining("Quelqu’un de cette entreprise") }] });
  });

  it("doesn't take someone back once they've finished it", async () => {
    const { workspaceId, sequenceId, prospects } = await launched();
    await tickWorkspace(services, workspaceId);
    await withWorkspace(db, workspaceId, (tx) => tx.update(prospect).set({ state: "done" }));
    expect(await enroll(db, workspaceId, sequenceId, prospects.map((found) => found.id), now)).toMatchObject({ enrolled: 0, skipped: [{ why: expect.stringContaining("déjà suivi") }] });
  });

  it("starts someone right away on a running sequence, and a member can take them off", async () => {
    const made = await launched();
    const late = await peopleAt(made.workspaceId, made.listId, "900000002", [["Luc", "Petit"]]);
    await enroll(db, made.workspaceId, made.sequenceId, late.map((found) => found.id), now);
    const row = (await enrollmentsOf(made.workspaceId)).find((found) => found.prospectId === late[0].id);
    expect(row?.nextDueAt).toEqual(now);
    await removeFromSequence(db, made.workspaceId, row!.id);
    expect((await enrollmentsOf(made.workspaceId)).find((found) => found.id === row!.id)).toMatchObject({ status: "stopped", stopReason: "member" });
  });
});

describe("keeping workspaces apart", () => {
  it("can't see or touch another workspace's sequence", async () => {
    const mine = await launched();
    const other = await createTestWorkspace(db, "Autre");
    expect(await sequenceOf(db, other.workspaceId, mine.sequenceId)).toBeNull();
    expect(await sequencesOf(db, other.workspaceId)).toEqual([]);
    expect(await setPaused(db, other.workspaceId, mine.sequenceId, true)).toBe(false);
    expect(await messagesToReview(db, other.workspaceId, "failed")).toEqual([]);
    expect(await enroll(db, other.workspaceId, mine.sequenceId, mine.prospects.map((found) => found.id), now)).toBeNull();
    expect((await tickWorkspace(services, other.workspaceId)).sent).toBe(0);
    expect(sent.email).toEqual([]);
  });
});
