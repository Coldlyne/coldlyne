import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connectAndFirstRead, readNow } from "@/application/connection-use";
import { connectWithFields, disconnect } from "@/application/connections";
import { confirmContact, pushesOf, pushToCrm } from "@/application/contacts";
import { enroll } from "@/application/enrollments";
import { addFromRegistry, createList, prospectsOf, suppress, suppressedOf } from "@/application/prospects";
import { whatIsScheduled } from "@/application/scheduled-work";
import { tickWorkspace } from "@/application/scheduler";
import { createSequence, launchSequence, type StepInput } from "@/application/sequences";
import type { Services } from "@/application/services";
import { recordSignals, syncEveryWorkspace, syncWorkspace } from "@/application/signals";
import { tasksOf } from "@/application/tasks";
import { replyToProspect, setInterest, threadOf } from "@/application/threads";
import { saveSettings } from "@/application/workspace-settings";
import { createWorkspace } from "@/application/workspaces";
import { fromRegistry } from "@/domain/registry";
import type { Database } from "@/infrastructure/db/client";
import { connection, crmPush } from "@/infrastructure/db/schema/connections";
import { company } from "@/infrastructure/db/schema/prospects";
import { enrollment } from "@/infrastructure/db/schema/sequences";
import { workspace } from "@/infrastructure/db/schema/tenancy";
import { withWorkspace } from "@/infrastructure/db/tenant";
import type { Env } from "@/infrastructure/env";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { holding } from "./support/registry";

const sentMail = vi.hoisted(() => [] as { to: string }[]);

vi.mock("@/infrastructure/connectors", async (original) => {
  const real = await original<typeof import("@/infrastructure/connectors")>();
  return {
    ...real,
    adapterOf: (kind: string) =>
      kind !== "smtp"
        ? real.adapterOf(kind as never)
        : (context: { fields: Record<string, string> }) => ({
            check: async () => ({ ok: true, detail: "ok", label: context.fields.address }),
            sendEmail: async (email: { to: string }) => {
              sentMail.push({ to: email.to });
              return { messageId: `<m${sentMail.length}@mail>`, externalId: `e${sentMail.length}` };
            },
            signalsSince: async () => [],
          }),
  };
});

const HOLDING_NAME = holding().nom_complet as string;
const MONDAY = new Date("2026-11-09T09:00:00+01:00");
const ADDRESS = "https://crm.northwind.example";
const settings = { COLDLYNE_SECRETS_KEY: Buffer.alloc(32, 7).toString("base64"), BETTER_AUTH_URL: "https://coldlyne.test" } as Env;
const healthyDns = {
  resolveTxt: async (name: string) => (name.startsWith("_dmarc.") ? [["v=DMARC1; p=none"]] : [["v=spf1 include:mx.ovh.com ~all"]]),
  resolveMx: async () => [{ exchange: "mx.acme.example", priority: 10 }],
  resolveCname: async () => [] as string[],
};
const EMAIL: StepInput = { channel: "email", subject: "Bonjour", body: "Une idée" };
const FOLLOW_UP: StepInput = { channel: "email", waitDays: 1, body: "Relance" };

interface Entry {
  why: string;
  company: { name: string; domain: string | null; siren: string | null } | null;
  people: { emails: string[]; phones: string[]; linkedinUrl: string | null }[];
}

/** A Soldlyne as seen from the outside: who it says is off limits, and who it was handed. */
const crm = { offLimits: [] as Entry[], handedOver: [] as Record<string, unknown>[], refuse: false, down: false, deletedThere: false, productGone: false, calls: [] as string[] };

const crmFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = new URL(input.toString());
  crm.calls.push(`${init.method ?? "GET"} ${url.origin}${url.pathname}`);
  if (crm.down) return new Response(JSON.stringify({ error: "Down" }), { status: 503 });
  if (url.pathname === "/api/v1/workspace") return Response.json({ id: "w1", name: "Northwind CRM", handoverVersion: 2 });
  if (url.pathname === "/api/v1/do-not-prospect") return Response.json({ data: crm.offLimits, nextCursor: null, asOf: "x" });
  if (url.pathname === "/api/v1/handovers") {
    if (crm.refuse) return new Response(JSON.stringify({ error: "No" }), { status: 400 });
    if (crm.deletedThere) return new Response(JSON.stringify({ error: "person_deleted" }), { status: 409 });
    if (crm.productGone) return new Response(JSON.stringify({ error: "The product this key opens deals on is gone: make a new key in Settings." }), { status: 409 });
    crm.handedOver.push(JSON.parse(String(init.body)));
    return Response.json({ dealId: `deal-${crm.handedOver.length}`, personId: "p", companyId: "c", created: true }, { status: 201 });
  }
  throw new Error(`Unexpected ${url}`);
}) as typeof fetch;

let db: Database;
let services: Services;
let now: Date;

beforeAll(async () => {
  db = await createTestDatabase();
  services = { db, settings, fetch: crmFetch, now: () => now, dns: healthyDns };
});

beforeEach(() => {
  now = MONDAY;
  sentMail.length = 0;
  Object.assign(crm, { offLimits: [], handedOver: [], refuse: false, down: false, deletedThere: false, productGone: false, calls: [] });
});

const customer = (overrides: Partial<Entry> = {}): Entry => ({ why: "customer", company: null, people: [], ...overrides });
const withAddress = (...emails: string[]) => customer({ people: [{ emails, phones: [], linkedinUrl: null }] });

async function linked(workspaceId: string, userId: string) {
  const connected = await connectWithFields(services, workspaceId, userId, "soldlyne", { address: ADDRESS, apiKey: "sl_key" });
  if (!connected.ok) throw new Error(connected.error);
  return connected.connection.id;
}

/** A workspace with Jeanne on a list, her address known, linked to a CRM. */
async function space(name = "Northwind", inGroup?: { userId: string; group: string }) {
  const made = inGroup ? { userId: inGroup.userId, workspaceId: await createWorkspace(db, inGroup.userId, name, inGroup.group) } : await createTestWorkspace(db, name);
  const { workspaceId, userId } = made;
  await saveSettings(db, workspaceId, { senderName: name, senderAddress: "1 rue de la Paix, 75002 Paris" });
  const listId = await createList(db, workspaceId, "Holdings");
  await addFromRegistry(db, workspaceId, listId, [fromRegistry(holding())]);
  const [jeanne] = await prospectsOf(db, workspaceId, listId);
  await confirmContact(db, workspaceId, jeanne.id, { kind: "email", value: "jeanne@acme.example", page: "https://acme.example/c" });
  const mailbox = await connectWithFields(services, workspaceId, userId, "smtp", { address: "ada@northwind.example", smtpHost: "smtp.mail.example", smtpPort: "465", imapHost: "imap.mail.example", imapPort: "993", password: "p" });
  if (!mailbox.ok) throw new Error(mailbox.error);
  return { workspaceId, userId, listId, prospectId: jeanne.id, mailboxId: mailbox.connection.id };
}

async function enrolled({ workspaceId, userId, prospectId, mailboxId }: Awaited<ReturnType<typeof space>>, steps: StepInput[] = [EMAIL, FOLLOW_UP]) {
  const created = await createSequence(services, workspaceId, userId, { name: `Campagne ${crypto.randomUUID()}`, steps, channels: { email: [mailboxId] } });
  if (!created.ok) throw new Error(created.error);
  return { sequenceId: created.id, enrolled: await enroll(db, workspaceId, created.id, [prospectId], now) };
}

async function running(made: Awaited<ReturnType<typeof space>>, steps?: StepInput[]) {
  const { sequenceId } = await enrolled(made, steps);
  const launched = await launchSequence(services, made.workspaceId, sequenceId, "member");
  if (!launched.ok) throw new Error(launched.problems.join(" "));
}

const enrollmentsIn = (workspaceId: string) => withWorkspace(db, workspaceId, (tx) => tx.select().from(enrollment));
const listed = async (workspaceId: string) => Object.fromEntries((await suppressedOf(db, workspaceId)).map(({ value, reason }) => [value, reason]));

/** Jeanne wrote back. */
async function replied(made: Awaited<ReturnType<typeof space>>, detail = "Volontiers, jeudi ?") {
  await tickWorkspace(services, made.workspaceId);
  now = new Date(now.getTime() + 60_000);
  await recordSignals(db, made.workspaceId, made.mailboxId, [{ type: "replied", channel: "email", externalId: crypto.randomUUID(), address: "jeanne@acme.example", at: now, detail }]);
}

describe("connecting Soldlyne", () => {
  it("names the connection, keeps the key sealed, and has the hourly job read it", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const id = await linked(workspaceId, userId);
    const [row] = await withWorkspace(db, workspaceId, (tx) => tx.select().from(connection).where(eq(connection.id, id)));
    expect(row).toMatchObject({ kind: "soldlyne", label: "Northwind CRM", status: "connected" });
    expect(JSON.stringify(row)).not.toContain("sl_key");
    expect((await whatIsScheduled(db)).linking).toBe(true);
  });

  it("reads who is off limits at once: until then a sequence could write to a customer", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    crm.offLimits = [withAddress("client@acme.example")];
    expect((await connectAndFirstRead(services, workspaceId, userId, "soldlyne", { address: ADDRESS, apiKey: "sl_key" })).ok).toBe(true);
    expect(await listed(workspaceId)).toEqual({ "client@acme.example": "crm" });
  });

  it("is told a read failed when it can't, and stays connected to try again", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    crm.offLimits = [{ company: "nope" } as never];
    const connected = await connectAndFirstRead(services, workspaceId, userId, "soldlyne", { address: ADDRESS, apiKey: "sl_key" });
    expect(connected.ok).toBe(true);
    const [row] = await withWorkspace(db, workspaceId, (tx) => tx.select().from(connection));
    expect(row.status).toBe("failing");
    crm.offLimits = [];
    await syncEveryWorkspace(services);
    const [after] = await withWorkspace(db, workspaceId, (tx) => tx.select().from(connection));
    expect(after.status).toBe("connected");
  });

  it("refuses an address that isn't public https, and sends the key nowhere", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const refused = await connectWithFields(services, workspaceId, userId, "soldlyne", { address: "http://localhost:3000", apiKey: "sl_key" });
    expect(refused.ok).toBe(false);
    expect(crm.calls).toEqual([]);
  });
});

describe("a member pushing someone", () => {
  it("hands them over, once for the same note, and contacts nobody", async () => {
    const made = await space();
    const id = await linked(made.workspaceId, made.userId);
    expect(await pushToCrm(services, made.workspaceId, id, made.prospectId, "Intéressée")).toMatchObject({ ok: true, externalId: "deal-1", already: false });
    expect(await pushToCrm(services, made.workspaceId, id, made.prospectId, "Intéressée")).toMatchObject({ ok: true, externalId: "deal-1", already: true });
    expect(crm.handedOver).toHaveLength(1);
    expect(crm.handedOver[0]).toMatchObject({ company: { name: holding().nom_complet, siren: holding().siren }, person: { email: "jeanne@acme.example" }, note: "Intéressée" });
    expect(sentMail).toEqual([]);
  });
});

describe("someone replying", () => {
  it("is handed over on the next sync, with what they wrote, and never twice", async () => {
    const made = await space();
    await linked(made.workspaceId, made.userId);
    await running(made);
    await replied(made);
    await syncWorkspace(services, made.workspaceId);
    expect(crm.handedOver).toHaveLength(1);
    expect(crm.handedOver[0]).toMatchObject({ person: { email: "jeanne@acme.example" }, source: "EMAIL", note: "A répondu par Email : Volontiers, jeudi ?" });
    await syncWorkspace(services, made.workspaceId);
    expect(crm.handedOver).toHaveLength(1);
  });

  it("contacts nobody by being handed over: what went out is what the sequence had already sent", async () => {
    const made = await space();
    await linked(made.workspaceId, made.userId);
    await running(made);
    await replied(made);
    const before = sentMail.length;
    await syncWorkspace(services, made.workspaceId);
    expect(sentMail.length).toBe(before);
  });

  it("isn't handed over once read as not interested or the wrong person, and is if interested", async () => {
    for (const [interest, expected] of [["not_interested", 0], ["wrong_person", 0], ["interested", 1]] as const) {
      crm.handedOver.length = 0;
      const made = await space();
      await linked(made.workspaceId, made.userId);
      await running(made);
      await replied(made);
      await setInterest(db, made.workspaceId, made.prospectId, interest);
      await syncWorkspace(services, made.workspaceId);
      expect(crm.handedOver, interest).toHaveLength(expected);
    }
  });

  it("isn't handed over when they asked to stop", async () => {
    const made = await space();
    await linked(made.workspaceId, made.userId);
    await running(made);
    await tickWorkspace(services, made.workspaceId);
    await recordSignals(db, made.workspaceId, made.mailboxId, [{ type: "opted_out", channel: "email", externalId: "stop", address: "jeanne@acme.example", at: now, detail: "STOP" }]);
    await syncWorkspace(services, made.workspaceId);
    expect(crm.handedOver).toEqual([]);
  });

  it("waits for the CRM when it's down, says so, and goes through when it's back", async () => {
    const made = await space();
    const id = await linked(made.workspaceId, made.userId);
    await running(made);
    await replied(made);
    crm.down = true;
    expect((await syncWorkspace(services, made.workspaceId)).failing).toEqual(["Northwind CRM"]);
    const [row] = await withWorkspace(db, made.workspaceId, (tx) => tx.select().from(connection).where(eq(connection.id, id)));
    expect(row.status).toBe("failing");
    crm.down = false;
    await syncWorkspace(services, made.workspaceId);
    expect(crm.handedOver).toHaveLength(1);
    const [back] = await withWorkspace(db, made.workspaceId, (tx) => tx.select().from(connection).where(eq(connection.id, id)));
    expect(back).toMatchObject({ status: "connected", lastError: null });
  });

  it("lets a CRM that refuses one person leave the next through", async () => {
    const made = await space();
    await linked(made.workspaceId, made.userId);
    await running(made);
    await replied(made);
    crm.refuse = true;
    expect((await syncWorkspace(services, made.workspaceId)).failing).toEqual(["Northwind CRM"]);
    expect(crm.calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);
  });
});

describe("someone deleted in Soldlyne", () => {
  const handOverCalls = () => crm.calls.filter((call) => call.startsWith("POST"));

  it("is left alone when they reply: no retry, no error on the connection, no failing job, and the reply stays here", async () => {
    const made = await space();
    const id = await linked(made.workspaceId, made.userId);
    await running(made);
    await replied(made);
    crm.deletedThere = true;
    expect(await syncWorkspace(services, made.workspaceId)).toMatchObject({ failing: [] });
    expect(handOverCalls()).toHaveLength(1);
    const [row] = await withWorkspace(db, made.workspaceId, (tx) => tx.select().from(connection).where(eq(connection.id, id)));
    expect(row).toMatchObject({ status: "connected", lastError: null });
    expect(crm.handedOver).toEqual([]);
    expect((await threadOf(db, made.workspaceId, made.prospectId))?.items.at(-1)).toMatchObject({ direction: "in", text: "Volontiers, jeudi ?" });
    await syncWorkspace(services, made.workspaceId);
    now = new Date("2026-11-11T06:00:00Z");
    await syncWorkspace(services, made.workspaceId);
    expect(handOverCalls()).toHaveLength(1);
  });

  it("doesn't count as handed over on the connection's page", async () => {
    const made = await space();
    const id = await linked(made.workspaceId, made.userId);
    await running(made);
    await replied(made);
    crm.deletedThere = true;
    expect(await readNow(services, made.workspaceId, id)).toEqual({ ok: true, said: "0 nouvelle exclusion, 0 personne envoyée." });
  });

  it("tells a member who pushes them that nothing was written, and the list doesn't say sent", async () => {
    const made = await space();
    const id = await linked(made.workspaceId, made.userId);
    crm.deletedThere = true;
    expect(await pushToCrm(services, made.workspaceId, id, made.prospectId, "Intéressée")).toEqual({ ok: true, externalId: null, through: "Northwind CRM", already: false });
    expect(await pushToCrm(services, made.workspaceId, id, made.prospectId, "Intéressée")).toEqual({ ok: true, externalId: null, through: "Northwind CRM", already: true });
    expect(await pushesOf(db, made.workspaceId, [made.prospectId])).toEqual([]);
  });

  it("isn't how any other refusal is taken: a product gone says so on the connection, and they're still waiting", async () => {
    const made = await space();
    const id = await linked(made.workspaceId, made.userId);
    await running(made);
    await replied(made);
    crm.productGone = true;
    expect((await syncWorkspace(services, made.workspaceId)).failing).toEqual(["Northwind CRM"]);
    const [row] = await withWorkspace(db, made.workspaceId, (tx) => tx.select().from(connection).where(eq(connection.id, id)));
    expect(row.status).toBe("failing");
    crm.productGone = false;
    now = new Date("2026-11-11T06:00:00Z");
    await syncWorkspace(services, made.workspaceId);
    expect(crm.handedOver).toHaveLength(1);
  });
});

describe("a CRM's customers and open deals", () => {
  it("become exclusions of this workspace on each sync, and only of this one", async () => {
    const first = await space("First");
    const [{ group }] = await db.select({ group: workspace.directoryId }).from(workspace).where(eq(workspace.id, first.workspaceId));
    const second = await space("Second", { userId: first.userId, group });
    await linked(first.workspaceId, first.userId);
    crm.offLimits = [withAddress("client@acme.example"), customer({ why: "open_deal", company: { name: "Beta", domain: "beta.example", siren: "732829320" } })];
    await syncWorkspace(services, first.workspaceId);
    expect(await listed(first.workspaceId)).toEqual({ "client@acme.example": "crm", "beta.example": "crm", "siren:732829320": "crm", "company:beta": "crm" });
    expect(await listed(second.workspaceId)).toEqual({});
  });

  it("can't be enrolled, by their address, their whole domain, their company's site, SIREN or name", async () => {
    for (const offLimits of [
      withAddress("jeanne@acme.example"),
      customer({ company: { name: "Autre", domain: "acme.example", siren: null } }),
      customer({ company: { name: "Autre", domain: null, siren: holding().siren } }),
      customer({ company: { name: HOLDING_NAME, domain: null, siren: null } }),
    ]) {
      const made = await space();
      await linked(made.workspaceId, made.userId);
      crm.offLimits = [offLimits];
      await syncWorkspace(services, made.workspaceId);
      const added = (await enrolled(made)).enrolled;
      expect(added?.enrolled, JSON.stringify(offLimits)).toBe(0);
      expect(added?.skipped[0].why).toContain("liste d’exclusion");
    }
  });

  it("are known by their company's site even with no address to match", async () => {
    const made = await space();
    await withWorkspace(db, made.workspaceId, (tx) => tx.update(company).set({ website: "https://www.acme-site.example" }));
    await linked(made.workspaceId, made.userId);
    crm.offLimits = [customer({ company: { name: "Autre", domain: "acme-site.example", siren: null } })];
    await syncWorkspace(services, made.workspaceId);
    expect((await enrolled(made)).enrolled?.enrolled).toBe(0);
  });

  it("stop a sequence already running, and a call waiting for a member", async () => {
    const made = await space();
    await confirmContact(db, made.workspaceId, made.prospectId, { kind: "phone", value: "+33612345678", page: "https://acme.example/c" });
    await linked(made.workspaceId, made.userId);
    await running(made, [{ channel: "call", body: "Appeler." }]);
    await tickWorkspace(services, made.workspaceId);
    expect(await tasksOf(db, made.workspaceId, made.userId, true)).toHaveLength(1);
    crm.offLimits = [customer({ company: { name: HOLDING_NAME, domain: null, siren: null } })];
    await syncWorkspace(services, made.workspaceId);
    expect(await tasksOf(db, made.workspaceId, made.userId, true)).toEqual([]);
    expect((await enrollmentsIn(made.workspaceId))[0]).toMatchObject({ status: "stopped", stopReason: "suppressed" });
  });

  it("stop what's next at send time too, whichever of their details is listed", async () => {
    const made = await space();
    await linked(made.workspaceId, made.userId);
    await running(made);
    await tickWorkspace(services, made.workspaceId);
    expect(sentMail).toHaveLength(1);
    await withWorkspace(db, made.workspaceId, (tx) => tx.update(company).set({ website: "https://acme-next.example" }));
    crm.offLimits = [customer({ company: { name: "Autre", domain: "acme-next.example", siren: null } })];
    await syncWorkspace(services, made.workspaceId);
    now = new Date(now.getTime() + 2 * 86_400_000);
    await tickWorkspace(services, made.workspaceId);
    expect(sentMail).toHaveLength(1);
  });

  it("stay excluded when they leave the CRM, or the connection goes: only a decision takes them off", async () => {
    const made = await space();
    const id = await linked(made.workspaceId, made.userId);
    crm.offLimits = [withAddress("client@acme.example")];
    await syncWorkspace(services, made.workspaceId);
    crm.offLimits = [];
    await syncWorkspace(services, made.workspaceId);
    expect(await listed(made.workspaceId)).toEqual({ "client@acme.example": "crm" });
    await disconnect(services, made.workspaceId, id);
    expect(await listed(made.workspaceId)).toEqual({ "client@acme.example": "crm" });
  });

  it("don't hide what someone asked: an opt-out stays one, and a later one replaces the CRM's word", async () => {
    const made = await space();
    await linked(made.workspaceId, made.userId);
    await suppress(db, made.workspaceId, "asked@acme.example", "asked");
    await suppress(db, made.workspaceId, "client@mine.example");
    crm.offLimits = [withAddress("asked@acme.example", "client@mine.example", "later@acme.example")];
    await syncWorkspace(services, made.workspaceId);
    expect(await listed(made.workspaceId)).toMatchObject({ "asked@acme.example": "asked", "client@mine.example": "member", "later@acme.example": "crm" });
    await recordSignals(db, made.workspaceId, null, [{ type: "opted_out", channel: "email", externalId: "later-stop", address: "later@acme.example", at: now }]);
    expect(await listed(made.workspaceId)).toMatchObject({ "later@acme.example": "opted_out" });
    await suppress(db, made.workspaceId, "later@acme.example");
    expect(await listed(made.workspaceId)).toMatchObject({ "later@acme.example": "opted_out" });
  });

  it("add nothing when the CRM's answer can't be read, and say so", async () => {
    const made = await space();
    await linked(made.workspaceId, made.userId);
    crm.offLimits = [{ company: "nope" } as never];
    expect((await syncWorkspace(services, made.workspaceId)).failing).toEqual(["Northwind CRM"]);
    expect(await listed(made.workspaceId)).toEqual({});
  });

  it("are read on demand from the connection's page, which says what came of it", async () => {
    const made = await space();
    const id = await linked(made.workspaceId, made.userId);
    crm.offLimits = [withAddress("client@acme.example")];
    expect(await readNow(services, made.workspaceId, id)).toEqual({ ok: true, said: "1 nouvelle exclusion, 0 personne envoyée." });
  });
});

describe("someone in conversation who becomes a deal", () => {
  it("can still be answered by a member, and no sequence writes to them", async () => {
    const made = await space();
    await linked(made.workspaceId, made.userId);
    await running(made);
    await replied(made);
    await syncWorkspace(services, made.workspaceId);
    crm.offLimits = [withAddress("jeanne@acme.example")];
    now = new Date("2026-11-10T06:00:00Z");
    await syncWorkspace(services, made.workspaceId);
    expect(await listed(made.workspaceId)).toEqual({ "jeanne@acme.example": "crm" });
    expect((await enrollmentsIn(made.workspaceId))[0]).toMatchObject({ status: "stopped", stopReason: "replied" });
    sentMail.length = 0;
    expect(await replyToProspect(services, made.workspaceId, made.prospectId, { body: "Jeudi, parfait." })).toEqual({ ok: true, said: "Réponse envoyée." });
    expect(sentMail).toEqual([{ to: "jeanne@acme.example" }]);
    sentMail.length = 0;
    now = new Date(now.getTime() + 3 * 86_400_000);
    await tickWorkspace(services, made.workspaceId);
    expect(sentMail).toEqual([]);
  });

  it("still can't be answered once they asked to stop", async () => {
    const made = await space();
    await linked(made.workspaceId, made.userId);
    await running(made);
    await replied(made);
    crm.offLimits = [withAddress("jeanne@acme.example")];
    await syncWorkspace(services, made.workspaceId);
    await suppress(db, made.workspaceId, "jeanne@acme.example", "asked");
    expect((await replyToProspect(services, made.workspaceId, made.prospectId, { body: "x" })).ok).toBe(false);
  });
});

describe("how often Soldlyne is asked, since its database bills by the hour it is awake", () => {
  const DAILY_HOUR = new Date("2026-11-10T06:00:00Z");
  const LATER_THAT_DAY = new Date("2026-11-10T13:00:00Z");
  const NEXT_DAILY_HOUR = new Date("2026-11-11T06:00:00Z");
  const offLimitsReads = () => crm.calls.filter((call) => call.includes("do-not-prospect"));
  const handOvers = () => crm.calls.filter((call) => call.startsWith("POST"));

  /** Each on a database of its own: the scheduled pass goes over every workspace. */
  beforeEach(async () => {
    db = await createTestDatabase();
    services = { ...services, db };
  });

  /** Connected, its first read done, and the calls that took forgotten. */
  async function settled() {
    const made = await space();
    const connected = await connectAndFirstRead(services, made.workspaceId, made.userId, "soldlyne", { address: ADDRESS, apiKey: "sl_key" });
    if (!connected.ok) throw new Error(connected.error);
    crm.calls.length = 0;
    return { ...made, connectionId: connected.connection.id };
  }

  const rowOf = async ({ workspaceId, connectionId }: { workspaceId: string; connectionId: string }) => (await withWorkspace(db, workspaceId, (tx) => tx.select().from(connection).where(eq(connection.id, connectionId))))[0];

  it("reads who is off limits on connect", async () => {
    const made = await space();
    crm.offLimits = [withAddress("client@acme.example")];
    await connectAndFirstRead(services, made.workspaceId, made.userId, "soldlyne", { address: ADDRESS, apiKey: "sl_key" });
    expect(offLimitsReads().length).toBeGreaterThan(0);
    expect(await listed(made.workspaceId)).toEqual({ "client@acme.example": "crm" });
  });

  it("makes no call at all on a scheduled pass with nothing due, and leaves the connection as it was", async () => {
    const made = await settled();
    const before = await rowOf(made);
    now = LATER_THAT_DAY;
    await syncEveryWorkspace(services);
    expect(crm.calls).toEqual([]);
    expect(await rowOf(made)).toEqual(before);
  });

  it("reads who is off limits once in the daily hour, not again that hour or that day, and again the next", async () => {
    await settled();
    crm.offLimits = [withAddress("client@acme.example")];
    now = DAILY_HOUR;
    await syncEveryWorkspace(services);
    expect(offLimitsReads()).toHaveLength(1);
    now = new Date(DAILY_HOUR.getTime() + 600_000);
    await syncEveryWorkspace(services);
    now = LATER_THAT_DAY;
    await syncEveryWorkspace(services);
    expect(offLimitsReads()).toHaveLength(1);
    now = NEXT_DAILY_HOUR;
    await syncEveryWorkspace(services);
    expect(offLimitsReads()).toHaveLength(2);
  });

  it("does the daily read on a pass that finds someone who replied, without doing it hourly for them", async () => {
    const made = await settled();
    await running(made);
    await replied(made);
    now = DAILY_HOUR;
    await syncWorkspace(services, made.workspaceId);
    expect([offLimitsReads().length, handOvers().length]).toEqual([1, 1]);
  });

  it("calls to hand someone over when someone replied, reads nothing else, and calls no more once they've gone", async () => {
    const made = await settled();
    await running(made);
    await replied(made);
    now = LATER_THAT_DAY;
    await syncWorkspace(services, made.workspaceId);
    expect(handOvers()).toHaveLength(1);
    expect(offLimitsReads()).toEqual([]);
    crm.calls.length = 0;
    await syncWorkspace(services, made.workspaceId);
    expect(crm.calls).toEqual([]);
  });

  it("doesn't ask a failing CRM every hour for someone it refused: that waits for its next list, and clears when it works", async () => {
    const made = await settled();
    await running(made);
    await replied(made);
    now = LATER_THAT_DAY;
    crm.refuse = true;
    expect((await syncWorkspace(services, made.workspaceId)).failing).toEqual(["Northwind CRM"]);
    crm.calls.length = 0;
    now = new Date(LATER_THAT_DAY.getTime() + 3_600_000);
    await syncWorkspace(services, made.workspaceId);
    expect(crm.calls).toEqual([]);
    crm.refuse = false;
    now = NEXT_DAILY_HOUR;
    await syncWorkspace(services, made.workspaceId);
    expect(handOvers()).toHaveLength(1);
    expect(await rowOf(made)).toMatchObject({ status: "connected", lastError: null });
  });

  it("doesn't count a hand-over as having read who is off limits", async () => {
    const made = await settled();
    const before = await rowOf(made);
    await running(made);
    await replied(made);
    now = LATER_THAT_DAY;
    await syncWorkspace(services, made.workspaceId);
    expect((await rowOf(made)).syncedAt).toEqual(before.syncedAt);
  });

  it("keeps trying hourly a first read that failed: until it works, a sequence could write to a customer", async () => {
    const made = await space();
    crm.offLimits = [{ company: "nope" } as never];
    const connected = await connectAndFirstRead(services, made.workspaceId, made.userId, "soldlyne", { address: ADDRESS, apiKey: "sl_key" });
    if (!connected.ok) throw new Error(connected.error);
    crm.calls.length = 0;
    crm.offLimits = [withAddress("client@acme.example")];
    now = LATER_THAT_DAY;
    await syncWorkspace(services, made.workspaceId);
    expect(offLimitsReads()).toHaveLength(1);
    expect(await listed(made.workspaceId)).toEqual({ "client@acme.example": "crm" });
    crm.calls.length = 0;
    await syncWorkspace(services, made.workspaceId);
    expect(crm.calls).toEqual([]);
  });

  it("keeps what it read when a hand-over then fails, so that read isn't repeated", async () => {
    const made = await space();
    await linked(made.workspaceId, made.userId);
    await running(made);
    await replied(made);
    crm.refuse = true;
    now = LATER_THAT_DAY;
    await syncWorkspace(services, made.workspaceId);
    crm.refuse = false;
    crm.calls.length = 0;
    now = new Date(LATER_THAT_DAY.getTime() + 3_600_000);
    await syncWorkspace(services, made.workspaceId);
    expect(offLimitsReads()).toEqual([]);
  });

  it("reads at once when a member asks on the connection's page", async () => {
    const made = await settled();
    now = LATER_THAT_DAY;
    await readNow(services, made.workspaceId, made.connectionId);
    expect(offLimitsReads()).toHaveLength(1);
  });

  it("follows the daily rule when an assistant asks for a read of the workspace", async () => {
    const made = await settled();
    now = LATER_THAT_DAY;
    await syncWorkspace(services, made.workspaceId);
    expect(crm.calls).toEqual([]);
  });

  it("gives the hourly job nothing to wake its own database for when Soldlyne is all there is", async () => {
    await settled();
    await db.delete(connection).where(eq(connection.kind, "smtp"));
    expect(await whatIsScheduled(db)).toMatchObject({ reading: false, linking: true });
  });
});

describe("a CRM that isn't linked both ways", () => {
  it("gets nobody on its own and adds no exclusions: a member pushes", async () => {
    const made = await space();
    const pushed: unknown[] = [];
    const hubspot = await connectWithFields({ ...services, fetch: (async () => Response.json({ portalId: 1 })) as typeof fetch }, made.workspaceId, made.userId, "hubspot", { accessToken: "t" });
    expect(hubspot.ok).toBe(true);
    await running(made);
    await replied(made);
    await syncWorkspace({ ...services, fetch: (async (input: RequestInfo | URL) => {
      pushed.push(String(input));
      return Response.json({});
    }) as typeof fetch }, made.workspaceId);
    expect(pushed.filter((url) => String(url).includes("hubapi"))).toEqual([]);
    expect(await withWorkspace(db, made.workspaceId, (tx) => tx.select().from(crmPush))).toEqual([]);
  });
});
