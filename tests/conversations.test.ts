import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connectWithFields } from "@/application/connections";
import { confirmContact } from "@/application/contacts";
import { enroll } from "@/application/enrollments";
import { figuresOf } from "@/application/figures";
import { addFromRegistry, createList, prospectsOf } from "@/application/prospects";
import { tickWorkspace } from "@/application/scheduler";
import { createSequence, launchSequence, type StepInput } from "@/application/sequences";
import type { Signal } from "@/application/ports";
import type { Services } from "@/application/services";
import { recordOutreach, recordSignals } from "@/application/signals";
import { completeTask, leaveVoicemail, placeTaskCall, tasksOf } from "@/application/tasks";
import { conversationsOf, recordReplyByHand, recordWhatsappConsent, replyToProspect, setInterest, threadOf } from "@/application/threads";
import { createWatchlist, deleteWatchlist, runAllWatchlists, runWatchlist, watchlistsOf } from "@/application/watchlists";
import { memberPhoneOf, saveMemberPhone, saveSettings, senderOf, settingsOf } from "@/application/workspace-settings";
import { fromRegistry } from "@/domain/registry";
import type { Database } from "@/infrastructure/db/client";
import { suppression } from "@/infrastructure/db/schema/prospects";
import { enrollment, stepMessage } from "@/infrastructure/db/schema/sequences";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { letterPdf, parsedPostalAddress, postalAddressOf } from "@/infrastructure/letters/pdf";
import { acceptsMail } from "@/infrastructure/dns/mail-domain";
import type { Env } from "@/infrastructure/env";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { fakeFetch } from "./support/fetch";
import { holding } from "./support/registry";

const sent: Record<string, unknown>[] = [];
const alerts: { event: string; title: string }[] = [];
const dialer: { placeCall?: ReturnType<typeof vi.fn>; dropVoicemail?: ReturnType<typeof vi.fn> } = {};
const behaviour: { sendFails?: boolean } = {};

vi.mock("@/infrastructure/connectors", () => ({
  adapterOf: (kind: string) => (context: { fields: Record<string, string> }) => ({
    check: async () => ({ ok: true, detail: "ok", label: context.fields.address ?? kind }),
    ...(kind === "smtp"
      ? {
          sendEmail: async (email: Record<string, unknown>) => {
            if (behaviour.sendFails) throw new Error("Refusé par le serveur");
            sent.push(email);
            return { externalId: `m${sent.length}`, messageId: `<m${sent.length}@acme>` };
          },
          signalsSince: async () => [],
        }
      : {}),
    ...(kind === "twilio" ? dialer : {}),
    ...(kind === "slack" ? { notify: async (alert: { event: string; title: string }) => void alerts.push(alert) } : {}),
  }),
}));

const settings = { BETTER_AUTH_URL: "https://coldlyne.test", COLDLYNE_SECRETS_KEY: Buffer.alloc(32, 1).toString("base64") } as Env;
const MONDAY = new Date("2026-11-09T09:00:00Z");
const dns = {
  resolveTxt: async (name: string) => (name.startsWith("_dmarc.") ? [["v=DMARC1; p=none"]] : [["v=spf1 include:mx.ovh.com ~all"]]),
  resolveMx: async () => [{ exchange: "mx.acme.fr", priority: 10 }],
  resolveCname: async () => [] as string[],
};

let db: Database;
let services: Services;
let now: Date;

beforeAll(async () => {
  db = await createTestDatabase();
  services = { db, settings, fetch: fakeFetch([]).fetch, now: () => now, dns };
});
beforeEach(() => {
  now = MONDAY;
  sent.length = alerts.length = 0;
  behaviour.sendFails = false;
  delete dialer.placeCall;
  delete dialer.dropVoicemail;
});

async function campaign(steps: readonly StepInput[], contacts: { kind: string; value: string }[] = [{ kind: "email", value: "jeanne@acme.fr" }]) {
  const { workspaceId, userId } = await createTestWorkspace(db);
  await saveSettings(db, workspaceId, { senderName: "NORTHWIND", senderAddress: "1 rue de la Paix, 75002 Paris" });
  const mailbox = await connectWithFields(services, workspaceId, userId, "smtp", { address: "ada@northwind.fr", smtpHost: "s", smtpPort: "465", imapHost: "i", imapPort: "993", password: "p" });
  const twilio = await connectWithFields(services, workspaceId, userId, "twilio", { accountSid: "a", authToken: "t", callerId: "+33100000000" });
  expect([mailbox.ok, twilio.ok]).toEqual([true, true]);
  const listId = await createList(db, workspaceId, "Holdings");
  await addFromRegistry(db, workspaceId, listId, [fromRegistry(holding("900000001", { dirigeants: [{ type_dirigeant: "personne physique", nom: "MARTIN", prenoms: "JEANNE", qualite: "Présidente" }] }))]);
  const [found] = await prospectsOf(db, workspaceId, listId);
  for (const contact of contacts) await confirmContact(db, workspaceId, found.id, { ...contact, page: "https://acme.fr" } as Parameters<typeof confirmContact>[3]);
  const created = await createSequence(services, workspaceId, userId, { name: "Holdings", steps });
  if (!created.ok) throw new Error(created.error);
  await enroll(db, workspaceId, created.id, [found.id], now);
  const launch = await launchSequence(services, workspaceId, created.id, "member");
  if (!launch.ok) throw new Error(launch.problems.join(" "));
  return { workspaceId, userId, listId, prospectId: found.id, sequenceId: created.id };
}

const statusOf = async (workspaceId: string) => (await withWorkspace(db, workspaceId, (tx) => tx.select().from(enrollment)))[0];
const PHONE = { kind: "phone", value: "+33612345678" };
const CALL: StepInput = { channel: "call", body: "Bonjour {{firstName}}, je vous appelle de la part de {{sender}}." };
const EMAIL: StepInput = { channel: "email", subject: "Bonjour", body: "Une idée" };

describe("a member's list for the day", () => {
  it("holds what only a person may do, with its text and where to do it, and the sequence waits", async () => {
    const { workspaceId, userId, sequenceId } = await campaign([CALL, EMAIL], [PHONE, { kind: "email", value: "jeanne@acme.fr" }]);
    expect(await tickWorkspace(services, workspaceId)).toMatchObject({ tasks: 1, sent: 0 });
    const [task] = await tasksOf(db, workspaceId, userId);
    expect(task).toMatchObject({ channel: "call", text: "Bonjour Jeanne, je vous appelle de la part de NORTHWIND.", person: "Jeanne Martin", role: "Présidente", company: "ACME HOLDING", address: "+33612345678", sequence: "Holdings", sequenceId });
    expect((await statusOf(workspaceId)).status).toBe("waiting_member");
    expect((await tickWorkspace(services, workspaceId)).sent).toBe(0);
  });

  it("is each member's own, and can be seen by everyone", async () => {
    const { workspaceId } = await campaign([CALL], [PHONE]);
    await tickWorkspace(services, workspaceId);
    const someone = crypto.randomUUID();
    expect(await tasksOf(db, workspaceId, someone)).toEqual([]);
    expect(await tasksOf(db, workspaceId, someone, true)).toHaveLength(1);
  });

  it("carries on once it's done, remembering what was said", async () => {
    const { workspaceId, userId } = await campaign([CALL, EMAIL], [PHONE, { kind: "email", value: "jeanne@acme.fr" }]);
    await tickWorkspace(services, workspaceId);
    const [task] = await tasksOf(db, workspaceId, userId);
    expect(await completeTask(services, workspaceId, userId, task.id, "done", "A demandé de rappeler en janvier")).toEqual({ ok: true, said: "Noté." });
    expect(await tasksOf(db, workspaceId, userId)).toEqual([]);
    const [message] = await withWorkspace(db, workspaceId, (tx) => tx.select().from(stepMessage));
    expect(message).toMatchObject({ status: "done", outcome: "done", summary: "A demandé de rappeler en janvier", doneBy: userId });
    expect((await tickWorkspace(services, workspaceId)).sent).toBe(1);
  });

  it("branches on how a call ended", async () => {
    const steps: StepInput[] = [CALL, { ...EMAIL, condition: "no_answer", body: "Je n’ai pas pu vous joindre" }, { ...EMAIL, condition: "answered", body: "Merci pour cet échange" }];
    const answered = await campaign(steps, [PHONE, { kind: "email", value: "jeanne@acme.fr" }]);
    await tickWorkspace(services, answered.workspaceId);
    await completeTask(services, answered.workspaceId, answered.userId, (await tasksOf(db, answered.workspaceId, answered.userId))[0].id, "answered");
    await tickWorkspace(services, answered.workspaceId);
    expect(sent[0].text).toContain("Merci pour cet échange");
    sent.length = 0;
    const missed = await campaign(steps, [PHONE, { kind: "email", value: "jeanne@acme.fr" }]);
    await tickWorkspace(services, missed.workspaceId);
    await completeTask(services, missed.workspaceId, missed.userId, (await tasksOf(db, missed.workspaceId, missed.userId))[0].id, "no_answer");
    await tickWorkspace(services, missed.workspaceId);
    expect(sent[0].text).toContain("Je n’ai pas pu vous joindre");
  });

  it("stops the sequence when the person answers, like any reply", async () => {
    const { workspaceId, userId, prospectId } = await campaign([{ channel: "linkedin", body: "Bonjour" }, EMAIL], [{ kind: "linkedin", value: "https://linkedin.com/in/jeanne" }, { kind: "email", value: "jeanne@acme.fr" }]);
    await tickWorkspace(services, workspaceId);
    const [task] = await tasksOf(db, workspaceId, userId);
    expect(task.address).toBe("https://linkedin.com/in/jeanne");
    expect((await completeTask(services, workspaceId, userId, task.id, "replied", "Intéressée, à rappeler")).ok).toBe(true);
    expect(await statusOf(workspaceId)).toMatchObject({ status: "stopped", stopReason: "replied" });
    expect((await tickWorkspace(services, workspaceId)).sent).toBe(0);
    expect((await conversationsOf(db, workspaceId))[0]).toMatchObject({ prospectId, lastDetail: "Intéressée, à rappeler" });
  });

  it("can't be done twice, or for another workspace", async () => {
    const { workspaceId, userId } = await campaign([CALL], [PHONE]);
    await tickWorkspace(services, workspaceId);
    const [task] = await tasksOf(db, workspaceId, userId);
    await completeTask(services, workspaceId, userId, task.id, "done");
    expect((await completeTask(services, workspaceId, userId, task.id, "done")).ok).toBe(false);
    const other = await createTestWorkspace(db, "Autre");
    expect((await completeTask(services, other.workspaceId, other.userId, task.id, "done")).ok).toBe(false);
  });
});

describe("placing a call", () => {
  async function callable() {
    const made = await campaign([{ ...CALL, options: { recordingUrl: "https://acme.fr/message.mp3" } }], [PHONE]);
    await tickWorkspace(services, made.workspaceId);
    const [task] = await tasksOf(db, made.workspaceId, made.userId);
    return { ...made, task };
  }

  it("asks for the member's number first: it rings before the prospect", async () => {
    const { workspaceId, userId, task } = await callable();
    expect((await placeTaskCall(services, workspaceId, userId, task.id)).ok).toBe(false);
    expect(await memberPhoneOf(db, workspaceId, userId)).toBeNull();
    await saveMemberPhone(db, workspaceId, userId, "+33700000000");
    expect(await memberPhoneOf(db, workspaceId, userId)).toBe("+33700000000");
    dialer.placeCall = vi.fn().mockResolvedValue({ externalId: "CA1" });
    expect((await placeTaskCall(services, workspaceId, userId, task.id)).ok).toBe(true);
    expect(dialer.placeCall).toHaveBeenCalledWith({ memberPhone: "+33700000000", prospectPhone: "+33612345678", voicemailUrl: "https://acme.fr/message.mp3", reference: task.id });
    expect((await tasksOf(db, workspaceId, userId))[0].callId).toBe("CA1");
  });

  it("says why when the provider refuses", async () => {
    const { workspaceId, userId, task } = await callable();
    await saveMemberPhone(db, workspaceId, userId, "+33700000000");
    dialer.placeCall = vi.fn().mockRejectedValue(new Error("Crédit épuisé"));
    expect(await placeTaskCall(services, workspaceId, userId, task.id)).toEqual({ ok: false, error: "Crédit épuisé" });
  });

  it("closes the task when the provider reports how it ended", async () => {
    const { workspaceId, userId, task } = await callable();
    await saveMemberPhone(db, workspaceId, userId, "+33700000000");
    dialer.placeCall = vi.fn().mockResolvedValue({ externalId: "CA1" });
    await placeTaskCall(services, workspaceId, userId, task.id);
    await recordSignals(db, workspaceId, null, [{ type: "no_answer", channel: "call", externalId: "CA1", address: "+33612345678", at: now }]);
    expect(await tasksOf(db, workspaceId, userId)).toEqual([]);
    expect(await statusOf(workspaceId)).toMatchObject({ status: "finished", lastOutcome: "no_answer" });
  });

  it("closes it by the number where the provider gives no call id", async () => {
    const { workspaceId, userId, task } = await callable();
    await saveMemberPhone(db, workspaceId, userId, "+33700000000");
    dialer.placeCall = vi.fn().mockResolvedValue({ externalId: task.id });
    await placeTaskCall(services, workspaceId, userId, task.id);
    await recordSignals(db, workspaceId, null, [{ type: "answered", channel: "call", externalId: "aircall-77", address: "+33612345678", at: now }]);
    expect(await statusOf(workspaceId)).toMatchObject({ status: "finished", lastOutcome: "answered" });
  });

  it("leaves a voicemail only during a call placed from here", async () => {
    const { workspaceId, userId, task } = await callable();
    expect((await leaveVoicemail(services, workspaceId, task.id)).ok).toBe(false);
    await saveMemberPhone(db, workspaceId, userId, "+33700000000");
    dialer.placeCall = vi.fn().mockResolvedValue({ externalId: "CA1" });
    await placeTaskCall(services, workspaceId, userId, task.id);
    expect((await leaveVoicemail(services, workspaceId, task.id)).ok).toBe(false);
    dialer.dropVoicemail = vi.fn().mockResolvedValue(undefined);
    expect((await leaveVoicemail(services, workspaceId, task.id)).ok).toBe(true);
    expect(dialer.dropVoicemail).toHaveBeenCalledWith("CA1", "https://acme.fr/message.mp3");
  });
});

describe("a conversation", () => {
  async function answered() {
    const made = await campaign([EMAIL, { ...EMAIL, waitDays: 1, subject: null, body: "Relance" }]);
    await tickWorkspace(services, made.workspaceId);
    await recordSignals(db, made.workspaceId, null, [{ type: "replied", channel: "email", externalId: "r1", address: "jeanne@acme.fr", at: new Date(now.getTime() + 60_000), detail: "Volontiers, jeudi ?" }]);
    return made;
  }

  it("lists whoever answered, with what they said", async () => {
    const { workspaceId, prospectId } = await answered();
    expect(await conversationsOf(db, workspaceId)).toEqual([expect.objectContaining({ prospectId, person: "Jeanne Martin", company: "ACME HOLDING", state: "replied", interest: null, lastDetail: "Volontiers, jeudi ?" })]);
  });

  it("reads in order, what went out and what came back", async () => {
    const { workspaceId, prospectId } = await answered();
    const thread = await threadOf(db, workspaceId, prospectId);
    expect(thread?.items.map((item) => [item.direction, item.text])).toEqual([["out", "Une idée"], ["in", "Volontiers, jeudi ?"]]);
    expect(thread).toMatchObject({ person: "Jeanne Martin", role: "Présidente", whatsappConsent: false });
    expect(await threadOf(db, workspaceId, crypto.randomUUID())).toBeNull();
  });

  it("takes what the reply came to, and filters on it", async () => {
    const { workspaceId, prospectId } = await answered();
    expect(await setInterest(db, workspaceId, prospectId, "interested")).toBe(true);
    expect(await conversationsOf(db, workspaceId, "interested")).toHaveLength(1);
    expect(await conversationsOf(db, workspaceId, "not_now")).toEqual([]);
    expect(await setInterest(db, workspaceId, crypto.randomUUID(), "not_now")).toBe(false);
    expect((await figuresOf(db, workspaceId, new Date(now.getTime() - 1000))).interest).toEqual([{ interest: "interested", count: 1 }]);
  });

  it("answers from the same mailbox, in the same thread, with the same way out", async () => {
    const { workspaceId, prospectId } = await answered();
    sent.length = 0;
    now = new Date(MONDAY.getTime() + 3_600_000);
    expect(await replyToProspect(services, workspaceId, prospectId, { body: "Jeudi, parfait." })).toEqual({ ok: true, said: "Réponse envoyée." });
    expect(sent[0]).toMatchObject({ to: "jeanne@acme.fr", subject: "Re: Bonjour", inReplyTo: "<m1@acme>", references: ["<m1@acme>"] });
    expect(sent[0].text).toContain("Jeudi, parfait.");
    expect(sent[0].text).toContain("Pour ne plus recevoir");
    const thread = await threadOf(db, workspaceId, prospectId);
    expect(thread?.items.at(-1)).toMatchObject({ direction: "out", text: "Jeudi, parfait.", by: "member" });
  });

  it("won't write to someone who asked not to be, say nothing, or send without a sender", async () => {
    const { workspaceId, prospectId } = await answered();
    expect((await replyToProspect(services, workspaceId, prospectId, { body: " " })).ok).toBe(false);
    await withWorkspace(db, workspaceId, (tx) => tx.insert(suppression).values({ value: "jeanne@acme.fr", reason: "opted_out" }));
    expect((await replyToProspect(services, workspaceId, prospectId, { body: "x" })).ok).toBe(false);
    await saveSettings(db, workspaceId, { senderName: null });
    expect((await replyToProspect(services, workspaceId, prospectId, { body: "x" })).ok).toBe(false);
  });

  it("says why a reply couldn't go, and that nothing was sent to someone not written to", async () => {
    const { workspaceId, prospectId } = await answered();
    behaviour.sendFails = true;
    expect(await replyToProspect(services, workspaceId, prospectId, { body: "x" })).toEqual({ ok: false, error: "Refusé par le serveur" });
    expect((await replyToProspect(services, workspaceId, crypto.randomUUID(), { body: "x" })).ok).toBe(false);
  });

  it("takes an answer given where Coldlyne can't see it", async () => {
    const { workspaceId, prospectId } = await campaign([EMAIL, { ...EMAIL, waitDays: 1, body: "Relance" }]);
    await tickWorkspace(services, workspaceId);
    expect((await recordReplyByHand(services, workspaceId, prospectId, "linkedin", "Répondu sur LinkedIn")).ok).toBe(true);
    expect(await statusOf(workspaceId)).toMatchObject({ status: "stopped", stopReason: "replied" });
    expect((await threadOf(db, workspaceId, prospectId))?.items.at(-1)).toMatchObject({ direction: "in", text: "Répondu sur LinkedIn", channel: "linkedin" });
    expect((await recordReplyByHand(services, workspaceId, crypto.randomUUID(), "call", "x")).ok).toBe(false);
  });

  it("keeps a person's WhatsApp consent, and lets them take it back", async () => {
    const { workspaceId, prospectId } = await campaign([EMAIL]);
    expect(await recordWhatsappConsent(db, workspaceId, prospectId, true, now)).toBe(true);
    expect((await threadOf(db, workspaceId, prospectId))?.whatsappConsent).toBe(true);
    await recordWhatsappConsent(db, workspaceId, prospectId, false, now);
    expect((await threadOf(db, workspaceId, prospectId))?.whatsappConsent).toBe(false);
    expect(await recordWhatsappConsent(db, workspaceId, crypto.randomUUID(), true, now)).toBe(false);
  });
});

describe("a workspace's settings", () => {
  it("has defaults until a member changes them, including what an assistant reads first", async () => {
    const { workspaceId } = await createTestWorkspace(db);
    expect(await settingsOf(db, workspaceId)).toEqual({ approval: "autonomous", senderName: null, senderAddress: null, mailboxDailyCap: 40, brief: {} });
    await saveSettings(db, workspaceId, { approval: "approve_first", brief: { target: "Holdings du Rhône", tone: "Direct" } });
    await saveSettings(db, workspaceId, { mailboxDailyCap: 25 });
    expect(await settingsOf(db, workspaceId)).toMatchObject({ approval: "approve_first", mailboxDailyCap: 25, brief: { target: "Holdings du Rhône", tone: "Direct" } });
  });

  it("needs both a name and an address to name a sender", () => {
    expect(senderOf({ senderName: "X", senderAddress: " " })).toBeNull();
    expect(senderOf({ senderName: null, senderAddress: "Y" })).toBeNull();
    expect(senderOf({ senderName: " X ", senderAddress: " Y " })).toEqual({ name: "X", address: "Y" });
  });

  it("keeps each workspace's to itself", async () => {
    const one = await createTestWorkspace(db);
    const two = await createTestWorkspace(db);
    await saveSettings(db, one.workspaceId, { senderName: "Un" });
    expect((await settingsOf(db, two.workspaceId)).senderName).toBeNull();
  });
});

describe("the figures", () => {
  it("say what each step did and why people left", async () => {
    const { workspaceId } = await campaign([EMAIL, { channel: "linkedin", waitDays: 0, body: "Bonjour" }]);
    await tickWorkspace(services, workspaceId);
    const figures = await figuresOf(db, workspaceId, new Date(now.getTime() - 86_400_000));
    expect(figures.steps).toContainEqual({ sequence: "Holdings", position: 0, channel: "email", status: "sent", count: 1 });
    expect(figures.people.reduce((total, row) => total + row.count, 0)).toBe(1);
    expect(figures.sent).toEqual([{ day: "2026-11-09", channel: "email", count: 1 }]);
  });

  it("name the workspace they are of", async () => {
    const { workspaceId } = await campaign([EMAIL]);
    expect((await figuresOf(db, workspaceId, MONDAY)).workspace).toEqual({ id: workspaceId, name: "Northwind" });
  });

  /** A second sequence of the same workspace, on the same person, with one email sent from it an hour later. */
  async function writtenAgain(workspaceId: string, userId: string, prospectId: string, messageId: string) {
    const second = await createSequence(services, workspaceId, userId, { name: "Relance", steps: [EMAIL] });
    if (!second.ok) throw new Error(second.error);
    await enroll(db, workspaceId, second.id, [prospectId], now);
    const [joined] = await withWorkspace(db, workspaceId, (tx) => tx.select({ id: enrollment.id }).from(enrollment).where(eq(enrollment.sequenceId, second.id)));
    await recordOutreach(db, workspaceId, { connectionId: null, channel: "email", address: "jeanne@acme.fr", messageId, enrollmentId: joined.id, at: new Date(now.getTime() + 3_600_000) });
  }

  const signalAt = (externalId: string, overrides: Partial<Signal>): Signal => ({ type: "replied", channel: "email", externalId, address: "jeanne@acme.fr", at: new Date(now.getTime() + 7_200_000), ...overrides });

  it("say per day what each sequence sent, leaving out what wasn't on a sequence", async () => {
    const { workspaceId, userId, prospectId } = await campaign([EMAIL]);
    await tickWorkspace(services, workspaceId);
    await writtenAgain(workspaceId, userId, prospectId, "<second@acme>");
    await recordOutreach(db, workspaceId, { connectionId: null, channel: "email", address: "test@acme.fr", at: now });
    const { daily } = await figuresOf(db, workspaceId, new Date(now.getTime() - 1000));
    expect(daily.sent).toEqual([
      { day: "2026-11-09", sequence: "Holdings", channel: "email", count: 1 },
      { day: "2026-11-09", sequence: "Relance", channel: "email", count: 1 },
    ]);
  });

  it("count what came back once, for the sequence that wrote the message it answers, else the last to write to that address", async () => {
    const { workspaceId, userId, prospectId } = await campaign([EMAIL]);
    await tickWorkspace(services, workspaceId);
    await writtenAgain(workspaceId, userId, prospectId, "<second@acme>");
    await recordSignals(db, workspaceId, null, [signalAt("a", { inReplyTo: "<m1@acme>" }), signalAt("b", { type: "bounced" }), signalAt("c", { type: "opted_out", address: "stranger@acme.fr" })]);
    const { daily } = await figuresOf(db, workspaceId, new Date(now.getTime() - 1000));
    expect(daily.signals).toEqual(
      expect.arrayContaining([
        { day: "2026-11-09", sequence: "Holdings", channel: "email", type: "replied", count: 1 },
        { day: "2026-11-09", sequence: "Relance", channel: "email", type: "bounced", count: 1 },
        { day: "2026-11-09", sequence: null, channel: "email", type: "opted_out", count: 1 },
      ]),
    );
    expect(daily.signals).toHaveLength(3);
  });

  it("say per day who joined each list and what replies came to, by name of list and sequence only", async () => {
    const { workspaceId, prospectId, userId } = await campaign([EMAIL]);
    await tickWorkspace(services, workspaceId);
    await writtenAgain(workspaceId, userId, prospectId, "<second@acme>");
    await setInterest(db, workspaceId, prospectId, "interested");
    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Paris" }).format(new Date());
    const { daily } = await figuresOf(db, workspaceId, new Date(Date.now() - 86_400_000));
    expect(daily.prospects).toEqual([{ day: today, list: "Holdings", count: 1 }]);
    expect(daily.interest).toEqual([{ day: today, sequence: "Relance", interest: "interested", count: 1 }]);
    expect(JSON.stringify(daily)).not.toContain("jeanne");
  });

  it("leave out what came before the date asked", async () => {
    const { workspaceId, prospectId } = await campaign([EMAIL]);
    await tickWorkspace(services, workspaceId);
    await setInterest(db, workspaceId, prospectId, "interested");
    expect((await figuresOf(db, workspaceId, new Date(Math.max(Date.now(), now.getTime()) + 86_400_000))).daily).toEqual({ prospects: [], sent: [], signals: [], interest: [] });
  });
});

describe("a watchlist", () => {
  const BODACC = "GET https://bodacc-datadila.opendatasoft.com";
  const REGISTRY = "GET https://recherche-entreprises.api.gouv.fr/search";
  const announcement = (registre: string, id = "A-1") => ({ id, familleavis: "creation", dateparution: "2026-11-08", registre: [registre], commercant: "ACME", ville: "LYON", numerodepartement: "69", url_complete: "https://bodacc.fr/a" });
  const answers = (companies: ReturnType<typeof holding>[], total = 1) => [
    { match: BODACC, json: { total_count: total, results: companies.map((company) => announcement(`${company.siren.slice(0, 3)} ${company.siren.slice(3, 6)} ${company.siren.slice(6)}`, company.siren)) } },
    { match: REGISTRY, json: { results: companies, total_results: companies.length, page: 1, total_pages: 1 } },
  ];

  async function watching(query = {}, companies = [holding("900000001")]) {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const listId = await createList(db, workspaceId, "Nouvelles holdings");
    const fake = fakeFetch(answers(companies));
    const watcher = { ...services, fetch: fake.fetch };
    const id = await createWatchlist(db, workspaceId, userId, { name: "Holdings créées", query: { families: ["creation"], ...query }, listId });
    return { workspaceId, userId, listId, id, watcher, calls: fake.calls };
  }

  it("puts what it finds on its list, reads from where it stopped, and says how many", async () => {
    const { workspaceId, listId, id, watcher, calls } = await watching();
    expect(await runWatchlist(watcher, workspaceId, id)).toEqual({ ok: true, added: 1 });
    expect(await prospectsOf(db, workspaceId, listId)).toHaveLength(1);
    const [row] = await watchlistsOf(db, workspaceId);
    expect(row).toMatchObject({ lastAdded: 1, lastError: null, checkedUntil: now });
    expect(decodeURIComponent(String(calls[0].url))).toContain("2026-11-02");
    now = new Date("2026-11-10T09:00:00Z");
    expect(await runWatchlist(watcher, workspaceId, id)).toEqual({ ok: true, added: 0 });
    expect(decodeURIComponent(String(calls.at(-2)?.url))).toContain("2026-11-09");
  });

  it("keeps only what the registry says matches, and never a company that refused", async () => {
    const companies = [holding("900000001", { activite_principale: "62.01Z" }), holding("900000002", { opposition_diffusion_commerciale: true }), holding("900000003")];
    const { workspaceId, listId, id, watcher } = await watching({ activities: ["64.20Z"], legalForms: ["5710"] }, companies);
    expect(await runWatchlist(watcher, workspaceId, id)).toEqual({ ok: true, added: 1 });
    expect((await prospectsOf(db, workspaceId, listId)).map((found) => found.siren)).toEqual(["900000003"]);
  });

  it("alerts the workspace when it found someone, and not otherwise", async () => {
    const { workspaceId, userId, id, watcher } = await watching();
    await connectWithFields(services, workspaceId, userId, "slack", { webhookUrl: "https://hooks.slack.test/x" });
    await runWatchlist(watcher, workspaceId, id);
    expect(alerts).toEqual([expect.objectContaining({ event: "watchlist", title: expect.stringContaining("1 nouvelle personne") })]);
    now = new Date("2026-11-10T09:00:00Z");
    await runWatchlist(watcher, workspaceId, id);
    expect(alerts).toHaveLength(1);
  });

  it("notes a public service being down, and covers the gap next time", async () => {
    const { workspaceId, id } = await watching();
    const down = { ...services, fetch: (async () => new Response("", { status: 503 })) as typeof fetch };
    expect((await runWatchlist(down, workspaceId, id)).ok).toBe(false);
    const [row] = await watchlistsOf(db, workspaceId);
    expect(row.lastError).toBeTruthy();
    expect(row.checkedUntil).toBeNull();
  });

  it("says so when there are more announcements than it can read", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const listId = await createList(db, workspaceId, "Beaucoup");
    const fake = fakeFetch(answers([holding("900000001")], 5000));
    const id = await createWatchlist(db, workspaceId, userId, { name: "Trop large", query: {}, listId });
    expect((await runWatchlist({ ...services, fetch: fake.fetch }, workspaceId, id)).ok).toBe(true);
    const [row] = await watchlistsOf(db, workspaceId);
    expect(row.lastError).toContain("Trop d’annonces");
    expect(row.checkedUntil).toEqual(now);
  });

  it("can be removed, runs for every workspace, and is its workspace's own", async () => {
    const { workspaceId, id, watcher } = await watching();
    const other = await createTestWorkspace(db, "Autre");
    expect((await runWatchlist(watcher, other.workspaceId, id)).ok).toBe(false);
    expect(await deleteWatchlist(db, other.workspaceId, id)).toBe(false);
    expect((await runAllWatchlists(watcher)).checked).toBeGreaterThan(0);
    expect(await deleteWatchlist(db, workspaceId, id)).toBe(true);
    expect(await watchlistsOf(db, workspaceId)).toEqual([]);
  });
});

describe("a letter", () => {
  const sender = { name: "NORTHWIND", address: "1 rue de la Paix, 75002 Paris" };
  const to = { name: "Jeanne Martin", company: "ACME", lines: ["12 rue X"], postcode: "69002", city: "Lyon", country: "FR" as const };

  it("is a PDF, whatever is in the text", async () => {
    const pdf = await letterPdf({ from: postalAddressOf(sender), to, body: `Madame, voici une très longue phrase. ${"mot ".repeat(200)}\n\nBien à vous 🙂`, footer: "Pour vous opposer : https://coldlyne.test/u/x" });
    expect(Buffer.from(pdf).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("needs a sender address it can read", () => {
    expect(parsedPostalAddress(sender)).toEqual({ name: "NORTHWIND", lines: ["1 rue de la Paix"], postcode: "75002", city: "Paris", country: "FR" });
    expect(parsedPostalAddress({ name: "X", address: "Paris" })).toBeNull();
    expect(() => postalAddressOf({ name: "X", address: "Paris" })).toThrow("code postal");
  });
});

describe("whether a domain takes mail", () => {
  const answer = (records: { exchange: string; priority: number }[]) => ({ resolveMx: async () => records });
  const failing = (code: string) => ({ resolveMx: async () => Promise.reject(Object.assign(new Error(code), { code })) });

  it("says yes with a mail server, no without one or with a null MX", async () => {
    expect(await acceptsMail("acme.fr", answer([{ exchange: "mx.acme.fr", priority: 10 }]))).toBe(true);
    expect(await acceptsMail("acme.fr", answer([{ exchange: "", priority: 0 }]))).toBe(false);
    expect(await acceptsMail("acme.fr", answer([]))).toBe(false);
    expect(await acceptsMail("nowhere.fr", failing("ENOTFOUND"))).toBe(false);
    expect(await acceptsMail("nowhere.fr", failing("ENODATA"))).toBe(false);
  });

  it("gives the benefit of the doubt when DNS doesn't answer: only a definite no keeps a message back", async () => {
    expect(await acceptsMail("acme.fr", failing("ETIMEOUT"))).toBe(true);
  });
});
