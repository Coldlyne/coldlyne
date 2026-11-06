import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connectWithFields } from "@/application/connections";
import { confirmContact } from "@/application/contacts";
import { elsewhereOf } from "@/application/directory";
import { addToSuppressionList, enroll, suppressedIn } from "@/application/enrollments";
import { approveMessages, messagesToReview, writeMessage } from "@/application/messages";
import { addCompanies, addFromRegistry, createList, prospectsOf, suppress, suppressedOf } from "@/application/prospects";
import { tickWorkspace } from "@/application/scheduler";
import { createSequence, launchSequence, type StepInput } from "@/application/sequences";
import type { Services } from "@/application/services";
import { recordSignals } from "@/application/signals";
import { tasksOf } from "@/application/tasks";
import { recordWhatsappConsent, replyToProspect, threadOf } from "@/application/threads";
import { unsubscribe, unsubscribeToken } from "@/application/unsubscribe";
import { saveSettings } from "@/application/workspace-settings";
import { createWorkspace } from "@/application/workspaces";
import { fromRegistry } from "@/domain/registry";
import type { Database } from "@/infrastructure/db/client";
import { company, suppression as suppressionTable } from "@/infrastructure/db/schema/prospects";
import { enrollment, stepMessage } from "@/infrastructure/db/schema/sequences";
import { workspace } from "@/infrastructure/db/schema/tenancy";
import { withWorkspace } from "@/infrastructure/db/tenant";
import type { Env } from "@/infrastructure/env";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { fakeFetch } from "./support/fetch";
import { holding } from "./support/registry";

const revalidateTag = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidateTag }));

/** What each mailbox sent, by its address: the mailbox and the sending domain are the whole point here. */
const sent: { from: string; to: string }[] = [];
let counter = 0;

vi.mock("@/infrastructure/connectors", () => ({
  adapterOf: (kind: string) => (context: { fields: Record<string, string> }) => ({
    check: async () => ({ ok: true, detail: "ok", label: context.fields.address ?? kind }),
    ...(kind === "smtp"
      ? {
          sendEmail: async (email: { to: string }) => {
            counter += 1;
            sent.push({ from: context.fields.address, to: email.to });
            return { externalId: `m${counter}`, messageId: `<m${counter}@mail.example>` };
          },
        }
      : {}),
  }),
}));

const settings = { BETTER_AUTH_URL: "https://coldlyne.test", COLDLYNE_SECRETS_KEY: Buffer.alloc(32, 1).toString("base64") } as Env;
/** A Monday, in office hours in Paris. */
const MONDAY = new Date("2026-11-09T09:00:00Z");
const DAY_MS = 86_400_000;
const JEANNE = "jeanne@acme.example";

const healthyDns = {
  resolveTxt: async (name: string) => (name.startsWith("_dmarc.") ? [["v=DMARC1; p=none"]] : [["v=spf1 include:mx.ovh.com ~all"]]),
  resolveMx: async () => [{ exchange: "mx.acme.example", priority: 10 }],
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
  sent.length = 0;
});

const TWO_EMAILS: StepInput[] = [
  { channel: "email", subject: "Bonjour", body: "Une idée." },
  { channel: "email", waitDays: 2, body: "Une relance." },
];

async function mailbox(workspaceId: string, userId: string, address: string) {
  const connected = await connectWithFields(services, workspaceId, userId, "smtp", { address, smtpHost: "smtp.mail.example", smtpPort: "465", imapHost: "imap.mail.example", imapPort: "993", password: "p" });
  if (!connected.ok) throw new Error(connected.error);
  return connected.connection.id;
}

/** A workspace ready to send, with Jeanne on a list of its own. */
async function workspaceWithJeanne(workspaceId: string, senderName: string, value = JEANNE) {
  await saveSettings(db, workspaceId, { senderName, senderAddress: "1 rue de la Paix, 75002 Paris" });
  const listId = await createList(db, workspaceId, "Holdings");
  await addFromRegistry(db, workspaceId, listId, [fromRegistry(holding())]);
  const [jeanne] = await prospectsOf(db, workspaceId, listId);
  await confirmContact(db, workspaceId, jeanne.id, { kind: "email", value, page: "https://acme.example/contact" });
  return { listId, jeanne };
}

async function sequenceFor(workspaceId: string, userId: string, mailboxes: string[], prospectIds: string[], steps: StepInput[] = TWO_EMAILS) {
  const created = await createSequence(services, workspaceId, userId, { name: `Campagne ${crypto.randomUUID()}`, steps, channels: { email: mailboxes } });
  if (!created.ok) throw new Error(created.error);
  const enrolled = await enroll(db, workspaceId, created.id, prospectIds, now);
  const launched = await launchSequence(services, workspaceId, created.id, "member");
  if (!launched.ok) throw new Error(launched.problems.join(" "));
  return { sequenceId: created.id, enrolled };
}

/** One owner's two businesses, each writing to the same Jeanne from its own mailboxes. */
async function twoBusinesses() {
  const { workspaceId: first, userId } = await createTestWorkspace(db, "Northwind");
  const [{ group }] = await db.select({ group: workspace.directoryId }).from(workspace).where(eq(workspace.id, first));
  const second = await createWorkspace(db, userId, "Contoso", group);
  const here = await workspaceWithJeanne(first, "Northwind");
  const there = await workspaceWithJeanne(second, "Contoso");
  expect(there.jeanne.personId).toBe(here.jeanne.personId);
  return { first, second, userId, here, there };
}

const enrollmentsOf = (workspaceId: string) => withWorkspace(db, workspaceId, (tx) => tx.select().from(enrollment));
const messagesOf = (workspaceId: string) => withWorkspace(db, workspaceId, (tx) => tx.select().from(stepMessage));
const stateOf = async (workspaceId: string, listId: string) => (await prospectsOf(db, workspaceId, listId))[0].state;
const stop = (workspaceId: string, address = JEANNE) => unsubscribe(services, unsubscribeToken(settings, workspaceId, address));

describe("a STOP", () => {
  it("stops every mailbox and sending domain of its workspace, what's already scheduled included", async () => {
    const { first, userId, here } = await twoBusinesses();
    const brands = [await mailbox(first, userId, "ada@brand-one.example"), await mailbox(first, userId, "ada@brand-two.example")];
    const { sequenceId } = await sequenceFor(first, userId, brands, [here.jeanne.id]);
    await tickWorkspace(services, first);
    expect(sent).toHaveLength(1);
    const [{ id: enrollmentId }] = await enrollmentsOf(first);
    const steps = await withWorkspace(db, first, (tx) => tx.query.sequenceStep.findMany({ where: (step, { eq: same }) => same(step.sequenceId, sequenceId) }));
    const written = await writeMessage(db, first, { enrollmentId, stepId: steps[1].id }, { body: "Écrit pour Jeanne, à envoyer ensuite." }, "assistant", now);
    expect(written.ok).toBe(true);

    await stop(first);

    expect(await enrollmentsOf(first)).toMatchObject([{ status: "stopped", stopReason: "opted_out", nextDueAt: null }]);
    expect((await messagesOf(first)).find(({ stepId }) => stepId === steps[1].id)).toMatchObject({ status: "skipped", note: expect.stringContaining("ne veut plus") });
    now = new Date(MONDAY.getTime() + 3 * DAY_MS);
    sent.length = 0;
    await tickWorkspace(services, first);
    expect(sent).toEqual([]);
  });

  it("holds for a mailbox connected afterwards, however the sequence came to be", async () => {
    const { first, userId, here } = await twoBusinesses();
    await stop(first);
    const later = await mailbox(first, userId, "ada@brand-three.example");
    const created = await createSequence(services, first, userId, { name: "Plus tard", steps: TWO_EMAILS, channels: { email: [later] } });
    if (!created.ok) throw new Error(created.error);

    expect(await enroll(db, first, created.id, [here.jeanne.id], now)).toMatchObject({ enrolled: 0, skipped: [{ why: expect.stringContaining("liste d’exclusion") }] });

    // Even someone put on it by hand, past every check: the rule is the last thing read before sending.
    await withWorkspace(db, first, async (tx) => {
      const [{ companyId }] = await tx.select({ companyId: company.id }).from(company).limit(1);
      await tx.insert(enrollment).values({ sequenceId: created.id, prospectId: here.jeanne.id, personId: here.jeanne.personId, companyId });
    });
    expect(await launchSequence(services, first, created.id, "member")).toMatchObject({ ok: true });
    await tickWorkspace(services, first);
    expect(sent).toEqual([]);
    expect((await enrollmentsOf(first)).find(({ sequenceId }) => sequenceId === created.id)).toMatchObject({ status: "stopped", stopReason: "suppressed" });
  });

  it("holds for a reply by hand from that workspace too", async () => {
    const { first, userId, here } = await twoBusinesses();
    const box = await mailbox(first, userId, "ada@brand-one.example");
    await sequenceFor(first, userId, [box], [here.jeanne.id]);
    await tickWorkspace(services, first);
    await stop(first);
    expect(await replyToProspect(services, first, here.jeanne.id, { body: "Une dernière chose." })).toMatchObject({ ok: false, error: expect.stringContaining("ne plus être contactée") });
  });

  it("doesn't stop another workspace of the directory, which keeps writing from its own mailbox", async () => {
    const { first, second, userId, here, there } = await twoBusinesses();
    const ours = await mailbox(first, userId, "ada@brand-one.example");
    const theirs = await mailbox(second, userId, "bea@other-brand.example");
    await sequenceFor(first, userId, [ours], [here.jeanne.id]);
    await sequenceFor(second, userId, [theirs], [there.jeanne.id]);
    await tickWorkspace(services, first);

    await stop(first);

    expect(await stateOf(first, here.listId)).toBe("opted_out");
    expect(await stateOf(second, there.listId)).toBe("in_sequence");
    expect(await enrollmentsOf(second)).toMatchObject([{ status: "active", stopReason: null }]);
    expect(await suppressedOf(db, first)).toMatchObject([{ value: JEANNE, reason: "opted_out" }]);
    expect(await suppressedOf(db, second)).toEqual([]);
    sent.length = 0;
    await tickWorkspace(services, second);
    expect(sent).toEqual([{ from: "bea@other-brand.example", to: JEANNE }]);
  });

  it("doesn't stop a message already scheduled by the other workspace", async () => {
    const { first, second, userId, there } = await twoBusinesses();
    const theirs = await mailbox(second, userId, "bea@other-brand.example");
    const { sequenceId } = await sequenceFor(second, userId, [theirs], [there.jeanne.id]);
    const [{ id: enrollmentId }] = await enrollmentsOf(second);
    const [step] = await withWorkspace(db, second, (tx) => tx.query.sequenceStep.findMany({ where: (row, { eq: same }) => same(row.sequenceId, sequenceId) }));
    await writeMessage(db, second, { enrollmentId, stepId: step.id }, { body: "Écrit pour Jeanne." }, "member", now);

    await stop(first);

    expect(await messagesOf(second)).toMatchObject([{ status: "draft" }]);
    await tickWorkspace(services, second);
    expect(sent).toEqual([{ from: "bea@other-brand.example", to: JEANNE }]);
  });

  it("comes up where the other workspace looks, with who and when, and lets it decide", async () => {
    const { first, second, userId, there } = await twoBusinesses();
    const box = await mailbox(first, userId, "ada@brand-one.example");
    const made = await sequenceFor(first, userId, [box], (await prospectsOf(db, first, (await withWorkspace(db, first, (tx) => tx.query.prospectList.findMany()))[0].id)).map(({ id }) => id));
    expect(made.enrolled?.enrolled).toBe(1);
    await tickWorkspace(services, first);
    await stop(first);

    expect(await elsewhereOf(db, second, [there.jeanne.personId])).toEqual([{ personId: there.jeanne.personId, person: "Jeanne Dupont-Martin", workspace: "Northwind", writtenAt: now, optedOutAt: expect.any(Date) }]);
    const { enrolled } = await sequenceFor(second, userId, [await mailbox(second, userId, "bea@other-brand.example")], [there.jeanne.id]);
    expect(enrolled).toMatchObject({ enrolled: 1, skipped: [], elsewhere: [{ workspace: "Northwind", optedOutAt: expect.any(Date) }] });
    const listId = await createList(db, second, "Une autre liste");
    expect(await addCompanies(services, second, listId, ["900000001"])).toMatchObject({ added: 1, elsewhere: [{ workspace: "Northwind", optedOutAt: expect.any(Date) }] });
  });

  it("is a member's word as much as the person's own, at once and for what waits for a member", async () => {
    const { first, second, userId, here, there } = await twoBusinesses();
    await confirmContact(db, first, here.jeanne.id, { kind: "linkedin", value: "https://www.linkedin.com/in/jeanne", page: "https://acme.example/equipe" });
    await sequenceFor(first, userId, [await mailbox(first, userId, "ada@brand-one.example")], [here.jeanne.id], [{ channel: "linkedin", body: "Bonjour" }]);
    await sequenceFor(second, userId, [await mailbox(second, userId, "bea@other-brand.example")], [there.jeanne.id], [{ channel: "linkedin", body: "Bonjour" }]);
    await tickWorkspace(services, first);
    await tickWorkspace(services, second);
    expect(await tasksOf(db, first, userId)).toHaveLength(1);

    await suppress(db, first, JEANNE, "asked");

    expect(await tasksOf(db, first, userId)).toEqual([]);
    expect(await enrollmentsOf(first)).toMatchObject([{ status: "stopped", stopReason: "opted_out" }]);
    expect(await stateOf(first, here.listId)).toBe("opted_out");
    expect(await tasksOf(db, second, userId)).toHaveLength(1);
    expect(await enrollmentsOf(second)).toMatchObject([{ status: "waiting_member", stopReason: null }]);
    expect(await stateOf(second, there.listId)).toBe("in_sequence");
  });

  it("can't be taken back by another workspace, which can't even read it", async () => {
    const { first, second } = await twoBusinesses();
    await stop(first);
    await withWorkspace(db, second, (tx) => tx.query.suppression.findMany()).then((rows) => expect(rows).toEqual([]));
    const removed = await withWorkspace(db, second, (tx) => tx.delete(suppressionTable).returning());
    expect(removed).toEqual([]);
    expect(await suppressedOf(db, first)).toHaveLength(1);
  });
});

describe("an exclusion a workspace made itself", () => {
  it("gives way to the person asking: the others are told, whichever came first", async () => {
    const { first, second, here, there } = await twoBusinesses();
    await suppress(db, first, JEANNE, "member");
    expect(await elsewhereOf(db, second, [there.jeanne.personId])).toEqual([]);
    await stop(first);
    expect(await suppressedOf(db, first)).toMatchObject([{ value: JEANNE, reason: "opted_out" }]);
    expect(await elsewhereOf(db, second, [there.jeanne.personId])).toMatchObject([{ workspace: "Northwind", optedOutAt: expect.any(Date) }]);
    expect(here.jeanne.personId).toBe(there.jeanne.personId);
  });

  it("gives way to a bounce: the address doesn't work for anyone", async () => {
    const { first, second } = await twoBusinesses();
    await suppress(db, first, JEANNE, "member");
    expect(await suppressedOf(db, second)).toEqual([]);
    await withWorkspace(db, first, (tx) => addToSuppressionList(tx, [{ value: JEANNE, reason: "bounced" }]));
    expect((await withWorkspace(db, second, suppressedIn)).bouncedElsewhere).toContain(JEANNE);
  });

  it("takes the same address twice in one read, as a mailbox can report it", async () => {
    const { first } = await twoBusinesses();
    const twice = ["stop-1", "stop-2"].map((externalId) => ({ type: "opted_out" as const, channel: "email" as const, externalId, address: "again@acme.example", at: now }));
    await recordSignals(db, first, null, twice);
    expect(await suppressedOf(db, first)).toMatchObject([{ value: "again@acme.example", reason: "opted_out" }]);
  });

  it("doesn't take the place of what someone asked: a later exclusion changes nothing", async () => {
    const { first } = await twoBusinesses();
    await stop(first);
    await suppress(db, first, JEANNE, "member");
    expect(await suppressedOf(db, first)).toMatchObject([{ value: JEANNE, reason: "opted_out" }]);
  });
});

describe("what a suppression matches", () => {
  it("is the address itself: a colleague at the same domain, at another company, isn't touched", async () => {
    const { first, userId } = await twoBusinesses();
    const listId = await createList(db, first, "Autres");
    await addFromRegistry(db, first, listId, [fromRegistry(holding("900000002", { dirigeants: [{ type_dirigeant: "personne physique", nom: "MARTIN", prenoms: "PAUL", qualite: "Gérant" }] }))]);
    const [paul] = await prospectsOf(db, first, listId);
    await confirmContact(db, first, paul.id, { kind: "email", value: "paul@acme.example", page: "https://acme.example/equipe" });
    await stop(first);
    await sequenceFor(first, userId, [await mailbox(first, userId, "ada@brand-one.example")], [paul.id]);
    await tickWorkspace(services, first);
    expect(sent).toEqual([{ from: "ada@brand-one.example", to: "paul@acme.example" }]);
  });

  it("is a whole domain when that's what's on the list, for any address at it, and only in that workspace", async () => {
    const { first, second, userId, here, there } = await twoBusinesses();
    await sequenceFor(first, userId, [await mailbox(first, userId, "ada@brand-one.example")], [here.jeanne.id]);
    await sequenceFor(second, userId, [await mailbox(second, userId, "bea@other-brand.example")], [there.jeanne.id]);

    await suppress(db, first, "ACME.example", "asked");

    expect(await enrollmentsOf(first)).toMatchObject([{ status: "stopped", stopReason: "opted_out" }]);
    await tickWorkspace(services, first);
    expect(sent).toEqual([]);
    await tickWorkspace(services, second);
    expect(sent).toEqual([{ from: "bea@other-brand.example", to: JEANNE }]);
  });

  it("stays the workspace's own exclusion when nobody asked: \"this domain is my client\"", async () => {
    const { first, second, userId, here, there } = await twoBusinesses();
    await sequenceFor(first, userId, [await mailbox(first, userId, "ada@brand-one.example")], [here.jeanne.id]);
    await sequenceFor(second, userId, [await mailbox(second, userId, "bea@other-brand.example")], [there.jeanne.id]);

    await suppress(db, first, "acme.example", "member");

    // At once, what waits for a member included, with no word of it reaching anyone else.
    expect(await enrollmentsOf(first)).toMatchObject([{ status: "stopped", stopReason: "suppressed" }]);
    await tickWorkspace(services, first);
    expect(sent).toEqual([]);
    expect(await suppressedOf(db, second)).toEqual([]);
    expect(await elsewhereOf(db, second, [there.jeanne.personId])).toEqual([]);
    await tickWorkspace(services, second);
    expect(sent).toEqual([{ from: "bea@other-brand.example", to: JEANNE }]);
  });
});

describe("a bounce", () => {
  const bounced = (workspaceId: string, connectionId: string, address = JEANNE) => recordSignals(db, workspaceId, connectionId, [{ type: "bounced", channel: "email", externalId: `bounce-${crypto.randomUUID()}`, address, at: now, detail: "550 5.1.1 User unknown" }]);

  /** Written to from the first workspace, whose mailbox then hears the address doesn't exist. */
  async function bouncedInFirst() {
    const made = await twoBusinesses();
    const box = await mailbox(made.first, made.userId, "ada@brand-one.example");
    await sequenceFor(made.first, made.userId, [box], [made.here.jeanne.id]);
    await tickWorkspace(services, made.first);
    await bounced(made.first, box);
    sent.length = 0;
    return made;
  }

  it("is a fact about the address, whoever wrote: another workspace of the group won't write to it either", async () => {
    const { second, userId, there } = await bouncedInFirst();
    expect((await withWorkspace(db, second, suppressedIn)).bouncedElsewhere).toContain(JEANNE);
    await sequenceFor(second, userId, [await mailbox(second, userId, "bea@other-brand.example")], [there.jeanne.id]);
    await tickWorkspace(services, second);
    expect(sent).toEqual([]);
  });

  it("doesn't put the address on the other workspace's list, which may not even know it", async () => {
    const { second } = await bouncedInFirst();
    expect(await suppressedOf(db, second)).toEqual([]);
  });

  it("keeps what the other workspace had scheduled from going to that address, and doesn't stop the sequence for good", async () => {
    const made = await twoBusinesses();
    const theirs = await mailbox(made.second, made.userId, "bea@other-brand.example");
    await sequenceFor(made.second, made.userId, [theirs], [made.there.jeanne.id]);
    const ours = await mailbox(made.first, made.userId, "ada@brand-one.example");
    await sequenceFor(made.first, made.userId, [ours], [made.here.jeanne.id]);
    await tickWorkspace(services, made.first);
    await bounced(made.first, ours);
    sent.length = 0;

    await tickWorkspace(services, made.second);

    expect(sent).toEqual([]);
    expect(await enrollmentsOf(made.second)).toMatchObject([{ status: "active", stopReason: null }]);
    await confirmContact(db, made.second, made.there.jeanne.id, { kind: "email", value: "jeanne.new@acme.example", page: "https://acme.example/equipe" });
    now = new Date(MONDAY.getTime() + 2 * DAY_MS);
    await tickWorkspace(services, made.second);
    expect(sent).toEqual([{ from: "bea@other-brand.example", to: "jeanne.new@acme.example" }]);
  });

  it("isn't an opt-out: the other workspace isn't told the person refused, and can reach them another way", async () => {
    const { second, there } = await bouncedInFirst();
    expect(await elsewhereOf(db, second, [there.jeanne.personId])).toMatchObject([{ workspace: "Northwind", optedOutAt: null, writtenAt: now }]);
    expect(await stateOf(second, there.listId)).toBe("new");
  });

  it("stays inside the group: another group still writes to that address, even with the same owner", async () => {
    const { userId } = await bouncedInFirst();
    const other = await createWorkspace(db, userId, "Fabrikam");
    const theirs = await workspaceWithJeanne(other, "Fabrikam");
    expect((await withWorkspace(db, other, suppressedIn)).bouncedElsewhere.size).toBe(0);
    await sequenceFor(other, userId, [await mailbox(other, userId, "cleo@fabrikam.example")], [theirs.jeanne.id]);
    await tickWorkspace(services, other);
    expect(sent).toEqual([{ from: "cleo@fabrikam.example", to: JEANNE }]);
  });

  it("doesn't change what a workspace's own opt-outs mean: nobody else reads those", async () => {
    const made = await bouncedInFirst();
    await suppress(db, made.first, "someone@acme.example", "asked");
    expect([...(await withWorkspace(db, made.second, suppressedIn)).bouncedElsewhere]).toEqual([JEANNE]);
  });
});

describe("what stays each business's own, when one person is shared", () => {
  it("is a yes to WhatsApp, given to one business only", async () => {
    const { first, second, here, there } = await twoBusinesses();
    await recordWhatsappConsent(db, first, here.jeanne.id, true, now);
    expect(await threadOf(db, first, here.jeanne.id)).toMatchObject({ whatsappConsent: true });
    expect(await threadOf(db, second, there.jeanne.id)).toMatchObject({ whatsappConsent: false });
    await recordWhatsappConsent(db, second, there.jeanne.id, true, now);
    await recordWhatsappConsent(db, first, here.jeanne.id, false, now);
    expect(await threadOf(db, first, here.jeanne.id)).toMatchObject({ whatsappConsent: false });
    expect(await threadOf(db, second, there.jeanne.id)).toMatchObject({ whatsappConsent: true });
  });

  it("is what a reply or a colleague's stop does: the other workspace's people keep going", async () => {
    const { first, second, userId, here, there } = await twoBusinesses();
    const box = await mailbox(first, userId, "ada@brand-one.example");
    await sequenceFor(first, userId, [box], [here.jeanne.id]);
    await sequenceFor(second, userId, [await mailbox(second, userId, "bea@other-brand.example")], [there.jeanne.id]);
    await tickWorkspace(services, first);
    await recordSignals(db, first, box, [{ type: "replied", channel: "email", externalId: "reply-1", address: JEANNE, at: now, detail: "Volontiers" }]);
    expect(await stateOf(first, here.listId)).toBe("replied");
    expect(await enrollmentsOf(second)).toMatchObject([{ status: "active", stopReason: null }]);
    expect(await threadOf(db, second, there.jeanne.id)).toMatchObject({ items: [] });
  });
});

describe("a company that refuses commercial use of its data", () => {
  it("stays out everywhere: another workspace hearing it stops what was scheduled here", async () => {
    const { first, second, userId, here } = await twoBusinesses();
    const { sequenceId } = await sequenceFor(first, userId, [await mailbox(first, userId, "ada@brand-one.example")], [here.jeanne.id]);
    const [{ id: enrollmentId }] = await enrollmentsOf(first);
    const [step] = await withWorkspace(db, first, (tx) => tx.query.sequenceStep.findMany({ where: (row, { eq: same }) => same(row.sequenceId, sequenceId) }));
    await writeMessage(db, first, { enrollmentId, stepId: step.id }, { body: "Écrit pour Jeanne." }, "member", now);
    await withWorkspace(db, second, (tx) => tx.update(company).set({ registryOptOut: true }).where(eq(company.siren, "900000001")));
    await tickWorkspace(services, first);
    expect(sent).toEqual([]);
    expect(await enrollmentsOf(first)).toMatchObject([{ status: "stopped", stopReason: "registry_opt_out" }]);
    expect(await messagesOf(first)).toMatchObject([{ status: "skipped", note: expect.stringContaining("refuse l’usage commercial") }]);
  });

  it("is refused a place on any sequence, whichever workspace asks", async () => {
    const { first, second, userId, here, there } = await twoBusinesses();
    await withWorkspace(db, first, (tx) => tx.update(company).set({ registryOptOut: true }).where(eq(company.siren, "900000001")));
    for (const [workspaceId, prospectId] of [[first, here.jeanne.id], [second, there.jeanne.id]]) {
      const created = await createSequence(services, workspaceId, userId, { name: "Refus", steps: TWO_EMAILS, channels: { email: [await mailbox(workspaceId, userId, `ada@${crypto.randomUUID()}.example`)] } });
      if (!created.ok) throw new Error(created.error);
      expect(await enroll(db, workspaceId, created.id, [prospectId], now)).toMatchObject({ enrolled: 0, skipped: [{ why: expect.stringContaining("refuse l’usage commercial") }] });
    }
  });
});

describe("a message waiting for approval", () => {
  it("stops with a STOP in its own workspace, and not with one in another", async () => {
    const { first, second, userId, here, there } = await twoBusinesses();
    for (const workspaceId of [first, second]) await saveSettings(db, workspaceId, { approval: "approve_first" });
    await sequenceFor(first, userId, [await mailbox(first, userId, "ada@brand-one.example")], [here.jeanne.id]);
    await sequenceFor(second, userId, [await mailbox(second, userId, "bea@other-brand.example")], [there.jeanne.id]);
    await tickWorkspace(services, first);
    await tickWorkspace(services, second);

    await stop(first);

    expect(await messagesToReview(db, first, "awaiting_approval")).toEqual([]);
    const waiting = await messagesToReview(db, second, "awaiting_approval");
    expect(waiting).toHaveLength(1);
    expect(await approveMessages(db, second, userId, waiting.map(({ id }) => id), now)).toBe(1);
    await tickWorkspace(services, second);
    expect(sent).toEqual([{ from: "bea@other-brand.example", to: JEANNE }]);
  });
});
