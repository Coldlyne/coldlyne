import { eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connectWithFields } from "@/application/connections";
import { confirmContact, contactsOf } from "@/application/contacts";
import { searchDirectory } from "@/application/directory";
import { enroll } from "@/application/enrollments";
import { importProspects } from "@/application/imports";
import { addFromRegistry, createList, prospectsOf, suppress, suppressedOf } from "@/application/prospects";
import { runScheduler, tickWorkspace } from "@/application/scheduler";
import { createSequence, launchSequence, type StepInput } from "@/application/sequences";
import type { Services } from "@/application/services";
import { recordOutreach, recordSignals } from "@/application/signals";
import { completeTask, tasksOf } from "@/application/tasks";
import { saveSettings } from "@/application/workspace-settings";
import { createWorkspace, startWorkspace } from "@/application/workspaces";
import { readProspectsCsv } from "@/domain/csv-import";
import { fromRegistry } from "@/domain/registry";
import type { Database } from "@/infrastructure/db/client";
import { user } from "@/infrastructure/db/schema/auth";
import { outreach } from "@/infrastructure/db/schema/connections";
import { company, suppression } from "@/infrastructure/db/schema/prospects";
import { enrollment, stepMessage } from "@/infrastructure/db/schema/sequences";
import { member, workspace } from "@/infrastructure/db/schema/tenancy";
import { withWorkspace } from "@/infrastructure/db/tenant";
import type { Env } from "@/infrastructure/env";
import { createTestDatabase, createTestWorkspace, databaseBeforeDirectory, rowsOf } from "./support/database";
import { fakeFetch } from "./support/fetch";
import { holding } from "./support/registry";

// What an independent review reproduced against the first version of the group: each of these failed on it.

const revalidateTag = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidateTag }));

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
const healthyDns = {
  resolveTxt: async (name: string) => (name.startsWith("_dmarc.") ? [["v=DMARC1; p=none"]] : [["v=spf1 include:mx.ovh.com ~all"]]),
  resolveMx: async () => [{ exchange: "mx.acme.example", priority: 10 }],
  resolveCname: async () => [] as string[],
};
const SENDER = { senderAddress: "1 rue de la Paix, 75002 Paris" };
const TWO_EMAILS: StepInput[] = [
  { channel: "email", subject: "Bonjour", body: "Une idée." },
  { channel: "email", waitDays: 2, body: "Une relance." },
];
const EMAIL_THEN_CALL: StepInput[] = [
  { channel: "email", subject: "Bonjour", body: "Une idée." },
  { channel: "call", waitDays: 0, body: "Appeler." },
];

let db: Database;
let services: Services;
let now: Date;

const servicesOn = (database: Database): Services => ({ db: database, settings, fetch: fakeFetch([]).fetch, now: () => now, dns: healthyDns });

beforeAll(async () => {
  db = await createTestDatabase();
  services = servicesOn(db);
});
beforeEach(() => {
  now = MONDAY;
  sent.length = 0;
});

const groupOf = async (workspaceId: string, database = db) => (await database.select({ id: workspace.directoryId }).from(workspace).where(eq(workspace.id, workspaceId)))[0].id;

async function mailbox(workspaceId: string, userId: string, address: string, on = services) {
  const connected = await connectWithFields(on, workspaceId, userId, "smtp", { address, smtpHost: "smtp.mail.example", smtpPort: "465", imapHost: "imap.mail.example", imapPort: "993", password: "p" });
  if (!connected.ok) throw new Error(connected.error);
  return connected.connection.id;
}

async function sequenceFor(workspaceId: string, userId: string, box: string, prospectIds: string[], steps = TWO_EMAILS) {
  const created = await createSequence(services, workspaceId, userId, { name: `Campagne ${crypto.randomUUID()}`, steps, channels: { email: [box] } });
  if (!created.ok) throw new Error(created.error);
  const enrolled = await enroll(db, workspaceId, created.id, prospectIds, now);
  const launched = await launchSequence(services, workspaceId, created.id, "member");
  if (!launched.ok) throw new Error(launched.problems.join(" "));
  return { sequenceId: created.id, enrolled };
}

/** Two spaces of one group, each with the same Jeanne on a list of its own. */
async function twoSpaces() {
  const { workspaceId: first, userId } = await createTestWorkspace(db, "Northwind");
  const second = await createWorkspace(db, userId, "Contoso", await groupOf(first));
  await saveSettings(db, first, { senderName: "Northwind", ...SENDER });
  await saveSettings(db, second, { senderName: "Contoso", ...SENDER });
  const [firstList, secondList] = [await createList(db, first, "Holdings"), await createList(db, second, "Holdings")];
  await addFromRegistry(db, first, firstList, [fromRegistry(holding())]);
  await addFromRegistry(db, second, secondList, [fromRegistry(holding())]);
  const [here] = await prospectsOf(db, first, firstList);
  const [there] = await prospectsOf(db, second, secondList);
  expect(there.personId).toBe(here.personId);
  return { first, second, userId, firstList, secondList, here, there };
}

const SIREN = holding().siren;
const fileWith = (fields: string) => readProspectsCsv(`prénom,nom,email,téléphone,société,siren\nJeanne,Dupont-Martin,${fields},ACME,${SIREN}\n`);
const enrollmentsOf = (workspaceId: string) => withWorkspace(db, workspaceId, (tx) => tx.select().from(enrollment));

describe("R1: an operator starting spaces for two customers", () => {
  it("keeps them apart: starting a space is a new group unless someone says otherwise", async () => {
    const ADMIN = { COLDLYNE_ADMINS: "ops@coldlyne.test" };
    const [ops, alice, bob] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await db.insert(user).values([
      { id: ops, name: "Ops", email: "ops@coldlyne.test" },
      { id: alice, name: "Alice", email: `${alice}@a.example` },
      { id: bob, name: "Bob", email: `${bob}@b.example` },
    ]);
    const operator = { userId: ops, email: "ops@coldlyne.test" };
    const a = (await startWorkspace(db, ADMIN, operator, "Customer A")) as string;
    const b = (await startWorkspace(db, ADMIN, operator, "Customer B")) as string;
    await db.insert(member).values([
      { workspaceId: a, userId: alice, role: "owner" },
      { workspaceId: b, userId: bob, role: "owner" },
    ]);
    await db.delete(member).where(eq(member.userId, ops));
    await saveSettings(db, b, { senderName: "B", ...SENDER });
    const secretList = await createList(db, b, "Secret list");
    await addFromRegistry(db, b, secretList, [fromRegistry(holding())]);
    const [theirs] = await prospectsOf(db, b, secretList);
    await confirmContact(db, b, theirs.id, { kind: "email", value: "jeanne@acme.example", page: "https://acme.example/contact" });
    await sequenceFor(b, bob, await mailbox(b, bob, "bob@b.example"), [theirs.id]);
    await tickWorkspace(services, b);

    expect(await groupOf(a)).not.toBe(await groupOf(b));
    expect(await searchDirectory(db, a, "ACME")).toEqual([]);
    expect(await contactsOf(db, a, [theirs.personId])).toEqual([]);
  });
});

describe("R2: someone who asked a space to stop, before the group existed", () => {
  it("isn't written to through the address another space found, once their rows merge", async () => {
    const before = await databaseBeforeDirectory();
    const database = before.db;
    const on = servicesOn(database);
    const [W1, W2] = ["a1000000-0000-4000-8000-000000000001", "a2000000-0000-4000-8000-000000000002"];
    const raw = (query: string) => database.execute(sql.raw(query));
    await raw(`insert into company(id,workspace_id,siren,name,source,created_at,updated_at) values ('c9000001-0000-4000-8000-0000000000a1','${W1}','900000099','RONDE SAS','registry','2026-10-01','2026-10-01'),('c9000001-0000-4000-8000-0000000000a2','${W2}','900000099','RONDE SAS','registry','2026-10-02','2026-10-02')`);
    await raw(`insert into person(id,workspace_id,company_id,first_name,last_name,source,created_at) values ('e9000001-0000-4000-8000-0000000000a1','${W1}','c9000001-0000-4000-8000-0000000000a1','Rene','Ronde','registry','2026-10-01'),('e9000001-0000-4000-8000-0000000000a2','${W2}','c9000001-0000-4000-8000-0000000000a2','Rene','Ronde','registry','2026-10-02')`);
    await raw(`insert into contact_detail(workspace_id,person_id,kind,value,page,source,created_at) values ('${W1}','e9000001-0000-4000-8000-0000000000a1','email','contact@ronde.example','https://ronde.example/c','website','2026-10-03'),('${W2}','e9000001-0000-4000-8000-0000000000a2','email','rene@perso.example',NULL,'import','2026-10-04')`);
    await raw(`insert into prospect_list(id,workspace_id,name) values ('f9000001-0000-4000-8000-0000000000a2','${W2}','L')`);
    await raw(`insert into prospect(id,workspace_id,list_id,person_id,state) values ('19000001-0000-4000-8000-0000000000a2','${W2}','f9000001-0000-4000-8000-0000000000a2','e9000001-0000-4000-8000-0000000000a2','in_sequence')`);
    await raw(`insert into sequence(id,workspace_id,name,status,"window",created_by) values ('29000001-0000-4000-8000-0000000000a2','${W2}','S','running','{"days":[1,2,3,4,5],"from":"09:00","to":"17:00","timezone":"Europe/Paris"}','ada')`);
    await raw(`insert into sequence_step(id,workspace_id,sequence_id,position,channel,subject,body,wait_days) values ('39000001-0000-4000-8000-0000000000a2','${W2}','29000001-0000-4000-8000-0000000000a2',0,'email','Bonjour','Parti',0),('39000002-0000-4000-8000-0000000000a2','${W2}','29000001-0000-4000-8000-0000000000a2',1,'email',NULL,'Relance',2)`);
    await raw(`insert into enrollment(id,workspace_id,sequence_id,prospect_id,person_id,company_id,status,last_position,next_due_at) values ('49000001-0000-4000-8000-0000000000a2','${W2}','29000001-0000-4000-8000-0000000000a2','19000001-0000-4000-8000-0000000000a2','e9000001-0000-4000-8000-0000000000a2','c9000001-0000-4000-8000-0000000000a2','active',0,'2026-11-08')`);
    await raw(`insert into step_message(workspace_id,enrollment_id,step_id,channel,subject,body,status,sent_at) values ('${W2}','49000001-0000-4000-8000-0000000000a2','39000001-0000-4000-8000-0000000000a2','email','Bonjour','Parti','sent','2026-11-02')`);
    await raw(`insert into outreach(workspace_id,channel,address,enrollment_id,sent_at) values ('${W2}','email','rene@perso.example','49000001-0000-4000-8000-0000000000a2','2026-11-02')`);
    await raw(`insert into suppression(workspace_id,value,reason) values ('${W2}','rene@perso.example','asked')`);
    await before.finishMigrating();

    const box = await mailbox(W2, "ada", "ada@contoso.example", on);
    await raw(`update sequence set channels = '{"email":["${box}"]}' where id='29000001-0000-4000-8000-0000000000a2'`);
    await raw(`update enrollment set mailbox_id='${box}' where id='49000001-0000-4000-8000-0000000000a2'`);
    await saveSettings(database, W2, { senderName: "Contoso", ...SENDER });
    await tickWorkspace(on, W2);

    expect(sent).toEqual([]);
    expect(rowsOf(await database.execute(sql`select status, stop_reason from enrollment where id = '49000001-0000-4000-8000-0000000000a2'`))).toEqual([{ status: "stopped", stop_reason: "suppressed" }]);
  });
});

describe("R3: which address a space writes to", () => {
  it("is its own before an older one another space found", async () => {
    const { first, second, userId, here, there, secondList } = await twoSpaces();
    await confirmContact(db, first, here.id, { kind: "email", value: "contact@acme.example", page: "https://acme.example/c" });
    await importProspects(services, second, secondList, fileWith("jeanne@own-file.example,"));
    await sequenceFor(second, userId, await mailbox(second, userId, "bea@contoso.example"), [there.id]);
    await tickWorkspace(services, second);
    expect(sent).toEqual([{ from: "bea@contoso.example", to: "jeanne@own-file.example" }]);
  });

  it("stays the one it already wrote to, when it brings another later", async () => {
    const { first, second, userId, here, there, secondList } = await twoSpaces();
    await confirmContact(db, first, here.id, { kind: "email", value: "contact@acme.example", page: "https://acme.example/c" });
    await sequenceFor(second, userId, await mailbox(second, userId, "bea@contoso.example"), [there.id]);
    await tickWorkspace(services, second);
    expect(sent.map(({ to }) => to)).toEqual(["contact@acme.example"]);
    await importProspects(services, second, secondList, fileWith("jeanne@own-file.example,"));
    now = new Date(MONDAY.getTime() + 2 * DAY_MS);
    sent.length = 0;
    await tickWorkspace(services, second);
    expect(sent.map(({ to }) => to)).toEqual(["contact@acme.example"]);
  });
});

describe("which number a task gives a member", () => {
  const CALL_ONLY: StepInput[] = [{ channel: "call", body: "Appeler." }];

  /** A second space calling Jeanne: another space found one number, its own file brought another. */
  async function callingJeanne() {
    const { first, second, userId, here, there, secondList } = await twoSpaces();
    await confirmContact(db, first, here.id, { kind: "phone", value: "+33611111111", page: "https://acme.example/c" });
    await importProspects(services, second, secondList, fileWith(",+33622222222"));
    await sequenceFor(second, userId, await mailbox(second, userId, "bea@contoso.example"), [there.id], CALL_ONLY);
    await tickWorkspace(services, second);
    const [{ id: enrollmentId }] = await enrollmentsOf(second);
    return { second, userId, enrollmentId };
  }

  it("is this space's own before an older one another space found", async () => {
    const { second, userId } = await callingJeanne();
    expect(await tasksOf(db, second, userId, true)).toMatchObject([{ channel: "call", address: "+33622222222" }]);
  });

  it("stays the one already called, so a conversation keeps its number", async () => {
    const { second, userId, enrollmentId } = await callingJeanne();
    await recordOutreach(db, second, { connectionId: null, channel: "call", address: "+33611111111", enrollmentId, at: now });
    expect(await tasksOf(db, second, userId, true)).toMatchObject([{ address: "+33611111111" }]);
  });

  it("isn't one that bounced here, even its own", async () => {
    const { second, userId } = await callingJeanne();
    await withWorkspace(db, second, (tx) => tx.insert(suppression).values({ value: "+33622222222", reason: "bounced" }));
    expect(await tasksOf(db, second, userId, true)).toMatchObject([{ address: "+33611111111" }]);
  });

  it("is what completing the task records, so a reply to that number is known", async () => {
    const { second, userId, enrollmentId } = await callingJeanne();
    const [task] = await tasksOf(db, second, userId, true);
    expect((await completeTask(services, second, userId, task.id, "no_answer")).ok).toBe(true);
    const written = await withWorkspace(db, second, (tx) => tx.select({ address: outreach.address }).from(outreach).where(eq(outreach.enrollmentId, enrollmentId)));
    expect(written).toEqual([{ address: "+33622222222" }]);
  });
});

describe("R4: another space's bounce", () => {
  /** The first space's address for Jeanne bounced there; the second's sequence was already running. */
  async function bouncedInFirst(secondHolds: string | null, steps: StepInput[]) {
    const made = await twoSpaces();
    await confirmContact(db, made.first, made.here.id, { kind: "email", value: "old@acme.example", page: "https://acme.example/c" });
    if (secondHolds) await importProspects(services, made.second, made.secondList, fileWith(secondHolds));
    const secondBox = await mailbox(made.second, made.userId, "bea@contoso.example");
    const { sequenceId } = await sequenceFor(made.second, made.userId, secondBox, [made.there.id], steps);
    const firstBox = await mailbox(made.first, made.userId, "ada@northwind.example");
    await sequenceFor(made.first, made.userId, firstBox, [made.here.id]);
    await tickWorkspace(services, made.first);
    await recordSignals(db, made.first, firstBox, [{ type: "bounced", channel: "email", externalId: "b1", address: "old@acme.example", at: now, detail: "550 5.1.1" }]);
    sent.length = 0;
    return { ...made, sequenceId, secondBox };
  }

  it("doesn't stop a sequence with another working address", async () => {
    const { second } = await bouncedInFirst("jeanne@works.example,+33612345678", EMAIL_THEN_CALL);
    await tickWorkspace(services, second);
    expect(sent).toEqual([{ from: "bea@contoso.example", to: "jeanne@works.example" }]);
    expect((await enrollmentsOf(second))[0].stopReason).toBeNull();
  });

  it("skips that address and carries on to a call, when it was the only one", async () => {
    const { first, second, userId, here } = await bouncedInFirst(null, EMAIL_THEN_CALL);
    await confirmContact(db, first, here.id, { kind: "phone", value: "+33612345678", page: "https://acme.example/c" });
    await tickWorkspace(services, second);
    expect(sent).toEqual([]);
    expect(await enrollmentsOf(second)).toMatchObject([{ status: "waiting_member", stopReason: null }]);
    expect(await tasksOf(db, second, userId, true)).toMatchObject([{ channel: "call", address: "+33612345678" }]);
    expect(await withWorkspace(db, second, (tx) => tx.select({ channel: stepMessage.channel, status: stepMessage.status, note: stepMessage.note }).from(stepMessage).where(eq(stepMessage.channel, "email")))).toMatchObject([{ status: "skipped", note: expect.stringContaining("refusée") }]);
  });

  it("doesn't stop a sequence for good when there's nothing else: it ends, unrefused", async () => {
    const { second, there, secondList } = await bouncedInFirst(null, TWO_EMAILS);
    await tickWorkspace(services, second);
    now = new Date(MONDAY.getTime() + 2 * DAY_MS);
    await tickWorkspace(services, second);
    expect(sent).toEqual([]);
    const [row] = await enrollmentsOf(second);
    expect(row.status).not.toBe("stopped");
    expect(row.stopReason).toBeNull();
    expect((await prospectsOf(db, second, secondList)).find(({ id }) => id === there.id)?.state).not.toBe("opted_out");
  });

  it("doesn't refuse someone a place on a sequence", async () => {
    const { second, userId, secondBox } = await bouncedInFirst("jeanne@works.example,+33612345678", EMAIL_THEN_CALL);
    const created = await createSequence(services, second, userId, { name: "Autre", steps: EMAIL_THEN_CALL, channels: { email: [secondBox] } });
    if (!created.ok) throw new Error(created.error);
    const anotherList = await createList(db, second, "Autre");
    await importProspects(services, second, anotherList, fileWith("jeanne@works.example,+33612345678"));
    const [again] = await prospectsOf(db, second, anotherList);
    await withWorkspace(db, second, (tx) => tx.update(enrollment).set({ status: "finished" }));
    expect(await enroll(db, second, created.id, [again.id], now)).toMatchObject({ enrolled: 1, skipped: [] });
  });
});

describe("R4, in a file: another space's bounce", () => {
  it("doesn't refuse a row: only this space's own list does", async () => {
    const { first, second, userId, here, firstList } = await twoSpaces();
    await importProspects(services, first, firstList, fileWith("dead@perso.example,"));
    const box = await mailbox(first, userId, "ada@northwind.example");
    await sequenceFor(first, userId, box, [here.id]);
    await tickWorkspace(services, first);
    await recordSignals(db, first, box, [{ type: "bounced", channel: "email", externalId: "b-file", address: "dead@perso.example", at: now, detail: "550" }]);
    const row = readProspectsCsv("prénom,nom,email,société,siren\nPaul,Martin,dead@perso.example,AUTRE,\n");
    const listId = await createList(db, second, "Fichier");
    expect(await importProspects(services, second, listId, row)).toMatchObject({ added: 1, rejected: [] });
    expect(await importProspects(services, first, await createList(db, first, "Fichier"), row)).toMatchObject({ added: 0, rejected: [{ why: expect.stringContaining("liste d’exclusion") }] });
  });
});

describe("R5: a company without a SIREN, known to two spaces", () => {
  it("is this space's own row when it imports again: nobody doubled, no namesake's city", async () => {
    const before = await databaseBeforeDirectory();
    await before.finishMigrating();
    const on = servicesOn(before.db);
    const [W2, LIST] = ["a2000000-0000-4000-8000-000000000002", "f0000001-0000-4000-8000-0000000000a2"];
    const dupontsOn = async () => (await prospectsOf(before.db, W2, LIST)).filter(({ lastName }) => lastName === "Dupont");
    expect(await dupontsOn()).toMatchObject([{ firstName: "Ana", city: "PARIS" }]);
    const imported = await importProspects(on, W2, LIST, readProspectsCsv("prénom,nom,email,société\nAna,Dupont,ana@dupont.example,Dupont Conseil\n"));
    expect(imported.added).toBe(0);
    expect(await dupontsOn()).toMatchObject([{ firstName: "Ana", city: "PARIS" }]);
  });
});

describe("R6: a company that refused commercial use of its data", () => {
  it("stops what waits for a member too, even in a space with nothing else due", async () => {
    const { first, second, userId, there } = await twoSpaces();
    await confirmContact(db, second, there.id, { kind: "phone", value: "+33612345678", page: "https://acme.example/c" });
    await sequenceFor(second, userId, await mailbox(second, userId, "bea@contoso.example"), [there.id], [{ channel: "call", body: "Appeler." }]);
    await tickWorkspace(services, second);
    expect(await tasksOf(db, second, userId, true)).toHaveLength(1);
    await withWorkspace(db, first, (tx) => tx.update(company).set({ registryOptOut: true }).where(eq(company.siren, SIREN)));

    await runScheduler(services);

    expect(await tasksOf(db, second, userId, true)).toEqual([]);
    expect(await enrollmentsOf(second)).toMatchObject([{ status: "stopped", stopReason: "registry_opt_out" }]);
  });
});

describe("R7: a space's own exclusion of one of someone's addresses", () => {
  it("stops them, even when another space's older address would be next", async () => {
    const { first, second, userId, here, there, secondList } = await twoSpaces();
    await confirmContact(db, first, here.id, { kind: "email", value: "contact@other-domain.example", page: "https://acme.example/c" });
    await importProspects(services, second, secondList, fileWith("jeanne@client.example,"));
    await sequenceFor(second, userId, await mailbox(second, userId, "bea@contoso.example"), [there.id]);
    await suppress(db, second, "jeanne@client.example", "member");
    await tickWorkspace(services, second);
    expect(sent).toEqual([]);
    expect(await enrollmentsOf(second)).toMatchObject([{ status: "stopped", stopReason: "suppressed" }]);
  });
});

describe("R8: what a space's suppression list shows", () => {
  it("is its own rows: another space's private address that bounced stays that space's", async () => {
    const { first, second, userId, here, firstList } = await twoSpaces();
    await importProspects(services, first, firstList, fileWith("jeanne.private@perso.example,"));
    const box = await mailbox(first, userId, "ada@northwind.example");
    await sequenceFor(first, userId, box, [here.id]);
    await tickWorkspace(services, first);
    await recordSignals(db, first, box, [{ type: "bounced", channel: "email", externalId: "b8", address: "jeanne.private@perso.example", at: now, detail: "550" }]);
    expect(await suppressedOf(db, first)).toMatchObject([{ value: "jeanne.private@perso.example", reason: "bounced" }]);
    expect(await suppressedOf(db, second)).toEqual([]);
  });

  it("isn't what sending goes by: the second space still won't write to that address", async () => {
    const { first, second, userId, here, there, firstList, secondList } = await twoSpaces();
    await importProspects(services, first, firstList, fileWith("dead@perso.example,"));
    const box = await mailbox(first, userId, "ada@northwind.example");
    await sequenceFor(first, userId, box, [here.id]);
    await tickWorkspace(services, first);
    await recordSignals(db, first, box, [{ type: "bounced", channel: "email", externalId: "b9", address: "dead@perso.example", at: now, detail: "550" }]);
    await importProspects(services, second, secondList, fileWith("dead@perso.example,"));
    sent.length = 0;
    await sequenceFor(second, userId, await mailbox(second, userId, "bea@contoso.example"), [there.id]);
    await tickWorkspace(services, second);
    expect(sent).toEqual([]);
  });
});
