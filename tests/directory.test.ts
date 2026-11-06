import { createMcpHandler } from "@modelcontextprotocol/server";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { coldlyneServer } from "@/app/api/mcp/server";
import { confirmContact, contactsOf } from "@/application/contacts";
import { elsewhereOf, findCompanies, lookUpCompanies, rememberCompanies, searchDirectory } from "@/application/directory";
import { groupOf, groupsOwnedBy, renameGroup } from "@/application/groups";
import { figuresOf } from "@/application/figures";
import { importProspects } from "@/application/imports";
import { acceptInvitation, inviteToWorkspace } from "@/application/invitations";
import { addCompanies, addFromRegistry, createList, listsOf, prospectsOf, suppress, suppressedOf } from "@/application/prospects";
import { createSequence, sequencesOf } from "@/application/sequences";
import type { Services } from "@/application/services";
import { changeRole, removeMember } from "@/application/team";
import { threadOf } from "@/application/threads";
import { settingsOf, saveSettings } from "@/application/workspace-settings";
import { createWorkspace, startWorkspace, workspacesOf, type MemberWorkspace } from "@/application/workspaces";
import { readProspectsCsv } from "@/domain/csv-import";
import { fromRegistry, type RegistryApiCompany } from "@/domain/registry";
import type { Database } from "@/infrastructure/db/client";
import { user } from "@/infrastructure/db/schema/auth";
import { apiKey, connection, connectionGrant, crmPush, outreach, signal } from "@/infrastructure/db/schema/connections";
import { company, contactDetail, person, prospect, suppression, whatsappConsent } from "@/infrastructure/db/schema/prospects";
import { enrollment, sequence, sequenceStep, stepMessage, watchlist, workspaceSettings } from "@/infrastructure/db/schema/sequences";
import { directory, invitation, member, workspace } from "@/infrastructure/db/schema/tenancy";
import { withWorkspace } from "@/infrastructure/db/tenant";
import type { Env } from "@/infrastructure/env";
import { createTestDatabase, createTestWorkspace, rowsOf } from "./support/database";
import { fakeFetch } from "./support/fetch";
import { expectFrenchTypography } from "./support/french";
import { holding } from "./support/registry";

const settings = { COLDLYNE_ADMINS: "founder@example.com", BETTER_AUTH_URL: "https://coldlyne.test", COLDLYNE_SECRETS_KEY: Buffer.alloc(32, 1).toString("base64") } as Env;
const NOW = new Date("2026-11-06T09:00:00Z");
const DAY_MS = 86_400_000;

let db: Database;
/** Any call out fails loudly: a test using these services proves nobody asked the registry. */
let noLookups: Services;

beforeAll(async () => {
  db = await createTestDatabase();
  noLookups = { db, settings, fetch: fakeFetch([]).fetch, now: () => NOW };
});

const registry = (...companies: RegistryApiCompany[]) => fakeFetch([{ match: "GET https://recherche-entreprises.api.gouv.fr/search", json: { results: companies, total_results: companies.length, page: 1, total_pages: 1 } }]);
const asking = (fake: ReturnType<typeof fakeFetch>): Services => ({ ...noLookups, fetch: fake.fetch });

const directoryOf = async (workspaceId: string) => (await db.select({ id: workspace.directoryId }).from(workspace).where(eq(workspace.id, workspaceId)))[0].id;

/** An owner with two workspaces in one group, which is what makes a group worth having. */
async function ownerOfTwo(names: [string, string] = ["Northwind", "Contoso"]) {
  const { workspaceId: first, userId } = await createTestWorkspace(db, names[0]);
  return { userId, first, second: await createWorkspace(db, userId, names[1], await directoryOf(first)) };
}

async function someone(name = "Bea") {
  const id = crypto.randomUUID();
  await db.insert(user).values({ id, name, email: `${id}@example.test`, emailVerified: true });
  return id;
}

/** A company's director on a new list, with a published address. */
async function listed(workspaceId: string, siren = "900000001") {
  const listId = await createList(db, workspaceId, "Holdings");
  await addFromRegistry(db, workspaceId, listId, [fromRegistry(holding(siren))]);
  const [found] = await prospectsOf(db, workspaceId, listId);
  return { listId, prospectId: found.id, personId: found.personId };
}

const published = (workspaceId: string, prospectId: string, value = "jeanne@acme.example") => confirmContact(db, workspaceId, prospectId, { kind: "email", value, page: "https://acme.example/contact" });

function clientAs(userId: string, workspaces: MemberWorkspace[], services = noLookups) {
  const handler = createMcpHandler(() => coldlyneServer({ services, userId, workspaces }));
  return async (name: string, args: Record<string, unknown> = {}) => {
    const response = await handler.fetch(
      new Request("https://coldlyne.test/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      }),
    );
    const text = await response.text();
    return JSON.parse(text.startsWith("{") ? text : (text.split("\n").find((line) => line.startsWith("data: ")) ?? "").slice(6)).result;
  };
}

/**
 * One of every kind of row a workspace holds, each carrying a mark, so that a row seen from somewhere
 * else gives itself away whichever table it's in.
 */
async function everyKindOfRow(workspaceId: string, userId: string, mark: string, siren: string) {
  const listId = await createList(db, workspaceId, `${mark} list`);
  await addFromRegistry(db, workspaceId, listId, [fromRegistry(holding(siren, { nom_complet: `${mark} SAS` }))]);
  const [{ id: prospectId, personId }] = await prospectsOf(db, workspaceId, listId);
  await withWorkspace(db, workspaceId, async (tx) => {
    const [{ companyId }] = await tx.select({ companyId: person.companyId }).from(person).where(eq(person.id, personId));
    await tx.insert(contactDetail).values([
      { personId, kind: "email", value: `published-${mark}@acme.example`, page: `https://acme.example/${mark}`, source: "website" },
      { personId, kind: "email", value: `private-${mark}@acme.example`, source: "import" },
    ]);
    await tx.insert(suppression).values([
      { value: `own-${mark}.example`, reason: "member" },
      { value: `asked-${mark}@acme.example`, reason: "asked" },
      { value: `bounced-${mark}@acme.example`, reason: "bounced" },
    ]);
    await tx.insert(whatsappConsent).values({ personId, agreedAt: NOW });
    await tx.insert(workspaceSettings).values({ senderName: `${mark} sender`, senderAddress: "1 rue de la Paix, 75002 Paris" });
    const [mailbox] = await tx.insert(connection).values({ kind: "smtp", label: `${mark}@mail.example`, sealedCredentials: "sealed", hookToken: `${mark}-hook` }).returning({ id: connection.id });
    const [campaign] = await tx.insert(sequence).values({ name: `${mark} campaign`, window: { days: [1], from: "09:00", to: "17:00", timezone: "Europe/Paris" }, status: "running" }).returning({ id: sequence.id });
    const [step] = await tx.insert(sequenceStep).values({ sequenceId: campaign.id, position: 0, channel: "email", body: `${mark} step body` }).returning({ id: sequenceStep.id });
    const [enrolled] = await tx.insert(enrollment).values({ sequenceId: campaign.id, prospectId, personId, companyId }).returning({ id: enrollment.id });
    await tx.insert(stepMessage).values({ enrollmentId: enrolled.id, stepId: step.id, channel: "email", body: `${mark} message body`, status: "draft" });
    await tx.insert(outreach).values({ connectionId: mailbox.id, channel: "email", address: `outreach-${mark}@acme.example`, enrollmentId: enrolled.id, sentAt: NOW });
    await tx.insert(signal).values({ connectionId: mailbox.id, type: "replied", channel: "email", externalId: `${mark}-signal`, address: `signal-${mark}@acme.example`, at: NOW, detail: `${mark} reply` });
    await tx.insert(apiKey).values({ name: `${mark} key`, keyHash: `${mark}-${crypto.randomUUID()}`, prefix: "cl_" });
    await tx.insert(connectionGrant).values({ state: `${mark}-${crypto.randomUUID()}`, kind: "gmail", codeVerifier: "verifier", userId, expiresAt: NOW });
    await tx.insert(crmPush).values({ connectionId: mailbox.id, prospectId, externalId: `${mark}-crm`, noteHash: "", pushedAt: NOW });
    await tx.insert(watchlist).values({ name: `${mark} watch`, query: {}, listId });
    await tx.insert(invitation).values({ email: `${mark}@invited.example`, tokenHash: `${mark}-${crypto.randomUUID()}`, expiresAt: NOW });
  }).catch((error) => {
    throw new Error(`Seeding failed: ${error.cause?.message ?? error.message}`);
  });
  return { listId, prospectId, personId };
}

const SELECTABLE = sql`select table_name as name from information_schema.role_table_grants where grantee = 'coldlyne_app' and privilege_type = 'SELECT' and table_schema = 'public'`;

const rowsIn = async (tx: Database, query: ReturnType<typeof sql>) => rowsOf(await tx.execute(query));

/** What Postgres said when it refused, whichever way the driver wraps it. */
const refusalOf = (work: Promise<unknown>) => work.then(() => "allowed", (error) => String(error.cause?.message ?? error.message));

describe("two owners' directories", () => {
  async function twoOwners() {
    const northwind = await ownerOfTwo();
    const other = await createTestWorkspace(db, "Fabrikam");
    const seen = await everyKindOfRow(other.workspaceId, other.userId, "fabrikam", "900000099");
    return { northwind, other, seen };
  }

  it("work through a role that can't bypass row-level security", async () => {
    const { workspaceId } = await createTestWorkspace(db);
    const [role] = await withWorkspace(db, workspaceId, (tx) => rowsIn(tx, sql`select current_user as name, rolsuper, rolbypassrls from pg_roles where rolname = current_user`));
    expect(role).toEqual({ name: "coldlyne_app", rolsuper: false, rolbypassrls: false });
  });

  it("hide each other's rows in every table the app role can read, without filtering", async () => {
    const { northwind, other } = await twoOwners();
    const mine = await directoryOf(northwind.first);
    const theirs = await directoryOf(other.workspaceId);
    expect(mine).not.toBe(theirs);
    const tables = (await rowsIn(db, SELECTABLE)).map(({ name }) => name as string);
    for (const expected of ["company", "person", "contact_detail", "suppression", "prospect", "prospect_list", "sequence", "step_message", "connection", "signal", "outreach", "workspace", "member", "whatsapp_consent"]) expect(tables).toContain(expected);
    for (const table of tables) {
      const seenFromMine = await withWorkspace(db, northwind.first, (tx) => rowsIn(tx, sql`select to_jsonb(t)::text as row from ${sql.identifier(table)} t`));
      const text = JSON.stringify(seenFromMine);
      expect(text, table).not.toContain("fabrikam");
      expect(text, table).not.toContain(other.workspaceId);
      expect(text, table).not.toContain(theirs);
      // The seed reached this table: otherwise this test would prove nothing about it.
      const seenFromTheirs = await withWorkspace(db, other.workspaceId, (tx) => rowsIn(tx, sql`select count(*)::int as count from ${sql.identifier(table)}`));
      expect(seenFromTheirs[0].count, `${table} has no row to hide`).toBeGreaterThan(0);
    }
  });

  it("have row-level security on everything the app role can read", async () => {
    const tables = (await rowsIn(db, SELECTABLE)).map(({ name }) => name as string);
    const secured = await rowsIn(db, sql`select relname from pg_class where relkind = 'r' and relrowsecurity and relnamespace = 'public'::regnamespace`);
    for (const table of tables) expect(secured.map(({ relname }) => relname), table).toContain(table);
  });

  it("can't be reached by writing either", async () => {
    const { northwind, other, seen } = await twoOwners();
    const theirs = await directoryOf(other.workspaceId);
    const inMine = (work: (tx: Database) => Promise<unknown>) => withWorkspace(db, northwind.first, work);
    for (const table of ["company", "person", "contact_detail"]) {
      const updated = await inMine((tx) => rowsIn(tx, sql`update ${sql.identifier(table)} set created_at = now() returning id`));
      expect(updated, table).toEqual([]);
    }
    expect(await refusalOf(inMine((tx) => tx.insert(company).values({ siren: "900000050", name: "Planted", source: "member", directoryId: theirs })))).toContain("row-level security");
    expect(await refusalOf(inMine((tx) => tx.insert(contactDetail).values({ personId: seen.personId, kind: "email", value: "planted@acme.example", page: "https://acme.example", source: "website", directoryId: theirs })))).toContain("row-level security");
    expect(await refusalOf(inMine((tx) => tx.insert(suppression).values({ workspaceId: other.workspaceId, value: "planted@acme.example", reason: "bounced" })))).toContain("row-level security");
    const mine = await listed(northwind.first, "900000010");
    const [row] = await withWorkspace(db, northwind.first, (tx) => tx.select({ id: company.id }).from(company).where(eq(company.siren, "900000010")));
    expect(await refusalOf(inMine((tx) => tx.update(company).set({ directoryId: theirs }).where(eq(company.id, row.id))))).toContain("row-level security");
    expect(await contactsOf(db, other.workspaceId, [mine.personId])).toEqual([]);
  });

  it("keep their own row for the same SIREN, each with its own facts", async () => {
    const { northwind, other } = await twoOwners();
    const mine = await listed(northwind.first, "900000020");
    const theirs = await listed(other.workspaceId, "900000020");
    expect(mine.personId).not.toBe(theirs.personId);
    await published(northwind.first, mine.prospectId);
    expect(await contactsOf(db, other.workspaceId, [theirs.personId])).toEqual([]);
    expect(await db.select().from(company).where(eq(company.siren, "900000020"))).toHaveLength(2);
  });

  it("don't answer for each other when asked by SIREN: the registry is asked instead", async () => {
    const { northwind, other } = await twoOwners();
    await listed(other.workspaceId, "900000030");
    expect(await searchDirectory(db, northwind.first, "900000030")).toEqual([]);
    const fake = registry(holding("900000030"));
    await lookUpCompanies(asking(fake), northwind.first, ["900000030"]);
    expect(fake.calls).toHaveLength(1);
  });

  it("say nothing of each other, whatever id is asked about", async () => {
    const { northwind, other, seen } = await twoOwners();
    expect(await contactsOf(db, northwind.first, [seen.personId])).toEqual([]);
    expect(await prospectsOf(db, northwind.first, seen.listId)).toEqual([]);
    expect(await threadOf(db, northwind.first, seen.prospectId)).toBeNull();
    expect(await elsewhereOf(db, northwind.first, [seen.personId])).toEqual([]);
    expect(JSON.stringify(await suppressedOf(db, northwind.first))).not.toContain("fabrikam");
    expect(JSON.stringify(await figuresOf(db, northwind.first, new Date(0)))).not.toContain("fabrikam");
    const call = clientAs(northwind.userId, [{ id: northwind.first, name: "Northwind", role: "owner", group: "Northwind" }]);
    expect((await call("read_thread", { prospectId: seen.prospectId })).isError).toBe(true);
    expect((await call("search_group", { words: "fabrikam" })).structuredContent).toEqual({ companies: [] });
    expect((await call("list_prospects", { listId: "not-a-uuid", workspace: other.workspaceId })).isError).toBe(true);
    expect((await call("list_lists", { workspace: other.workspaceId })).isError).toBe(true);
  });

  it("keep the app role out of the directory table and of what merging left behind", async () => {
    const { workspaceId } = await createTestWorkspace(db);
    expect(await refusalOf(withWorkspace(db, workspaceId, (tx) => tx.select().from(directory)))).toContain("permission denied");
    expect(await refusalOf(withWorkspace(db, workspaceId, (tx) => rowsIn(tx, sql`select * from directory_merge`)))).toContain("permission denied");
  });

  it("are out of reach of a transaction that claims another workspace through its session", async () => {
    const { northwind, other } = await twoOwners();
    // The directory follows from the workspace bound: there's no setting that says which directory to read.
    const theirs = await directoryOf(other.workspaceId);
    const [bound] = await withWorkspace(db, northwind.first, (tx) => rowsIn(tx, sql`select set_config('app.directory_id', ${theirs}, true), app_directory_id() as directory`));
    expect(bound.directory).toBe(await directoryOf(northwind.first));
  });
});

describe("the workspaces of one group", () => {
  it("share a company and a person, found once and kept once", async () => {
    const { first, second } = await ownerOfTwo();
    const here = await listed(first);
    const there = await listed(second);
    expect(there.personId).toBe(here.personId);
    expect(await withWorkspace(db, second, (tx) => tx.select().from(company))).toHaveLength(1);
    expect(await withWorkspace(db, second, (tx) => tx.select().from(person))).toHaveLength(1);
    expect(await directoryOf(first)).toBe(await directoryOf(second));
  });

  it("share what a page publishes, with the page", async () => {
    const { first, second } = await ownerOfTwo();
    const here = await listed(first);
    const there = await listed(second);
    await published(first, here.prospectId);
    expect(await contactsOf(db, second, [there.personId])).toEqual([{ personId: there.personId, kind: "email", value: "jeanne@acme.example", page: "https://acme.example/contact", source: "website" }]);
  });

  it("keep one row for an address both found", async () => {
    const { first, second } = await ownerOfTwo();
    const here = await listed(first);
    const there = await listed(second);
    await published(first, here.prospectId);
    await published(second, there.prospectId);
    expect(await contactsOf(db, first, [here.personId])).toHaveLength(1);
    expect(await db.select().from(contactDetail).where(eq(contactDetail.personId, here.personId))).toHaveLength(1);
  });

  it("don't share what a file brought: it has no page to say where it comes from, and may be private", async () => {
    const { first, second } = await ownerOfTwo();
    const csv = "prénom,nom,email,téléphone,société,siren\nJeanne,Dupont-Martin,jeanne.private@acme.example,+33612345678,ACME HOLDING,900000001\n";
    const listId = await createList(db, first, "Fichier");
    await importProspects(asking(registry(holding())), first, listId, readProspectsCsv(csv));
    const [{ personId }] = await prospectsOf(db, first, listId);
    expect((await contactsOf(db, first, [personId])).map(({ value }) => value).toSorted()).toEqual(["+33612345678", "jeanne.private@acme.example"]);
    expect(await contactsOf(db, second, [personId])).toEqual([]);
    expect((await searchDirectory(db, second, "900000001"))[0].people).toMatchObject([{ firstName: "Jeanne", contacts: [] }]);
  });

  it("learn of an address once it's published, even if another kept it privately first", async () => {
    const { first, second } = await ownerOfTwo();
    const listId = await createList(db, first, "Fichier");
    await importProspects(asking(registry(holding())), first, listId, readProspectsCsv("prénom,nom,email,société,siren\nJeanne,Dupont-Martin,jeanne@acme.example,ACME HOLDING,900000001\n"));
    const there = await listed(second);
    expect(await contactsOf(db, second, [there.personId])).toEqual([]);
    await published(second, there.prospectId);
    expect(await contactsOf(db, second, [there.personId])).toMatchObject([{ value: "jeanne@acme.example", page: "https://acme.example/contact" }]);
    // The workspace that held it privately sees it once, with the page that now says where it comes from.
    expect(await contactsOf(db, first, [there.personId])).toMatchObject([{ value: "jeanne@acme.example", page: "https://acme.example/contact" }]);
  });

  it("don't share lists, sequences, messages, mailboxes or anything else of their own", async () => {
    const { first, second, userId } = await ownerOfTwo();
    const here = await everyKindOfRow(first, userId, "northwind", "900000002");
    for (const table of ["prospect_list", "prospect", "sequence", "sequence_step", "enrollment", "step_message", "connection", "signal", "outreach", "api_key", "connection_grant", "crm_push", "workspace_settings", "watchlist", "invitation", "whatsapp_consent", "member"]) {
      const seen = await withWorkspace(db, second, (tx) => rowsIn(tx, sql`select to_jsonb(t)::text as row from ${sql.identifier(table)} t`));
      expect(JSON.stringify(seen), table).not.toContain("northwind");
      expect(JSON.stringify(seen), table).not.toContain(first);
    }
    expect(await listsOf(db, second)).toEqual([]);
    expect(await sequencesOf(db, second)).toEqual([]);
    expect(await settingsOf(db, second)).toMatchObject({ senderName: null, brief: {} });
    expect(await prospectsOf(db, second, here.listId)).toEqual([]);
    expect(await threadOf(db, second, here.prospectId)).toBeNull();
  });

  it("don't show on a workspace's lists what it has merely seen", async () => {
    const { first, second } = await ownerOfTwo();
    await rememberCompanies(db, first, [fromRegistry(holding())]);
    expect(await withWorkspace(db, first, (tx) => tx.select().from(company))).toHaveLength(1);
    expect(await withWorkspace(db, second, (tx) => tx.select().from(company))).toHaveLength(1);
    for (const workspaceId of [first, second]) {
      expect(await listsOf(db, workspaceId)).toEqual([]);
      expect(await withWorkspace(db, workspaceId, (tx) => tx.select().from(prospect))).toEqual([]);
    }
  });

  it("keep figures that mean what's on that workspace's lists", async () => {
    const { first, second } = await ownerOfTwo();
    await listed(first);
    const before = await figuresOf(db, second, new Date(0));
    expect(before.prospects).toEqual([]);
    expect(before.daily.prospects).toEqual([]);
    const listId = await createList(db, second, "Leurs holdings");
    await addCompanies(noLookups, second, listId, ["900000001"]);
    expect((await figuresOf(db, second, new Date(0))).prospects).toEqual([{ list: "Leurs holdings", state: "new", count: 1 }]);
    expect((await figuresOf(db, first, new Date(0))).prospects).toEqual([{ list: "Holdings", state: "new", count: 1 }]);
  });

  it("can't delete a shared row from one workspace, which would take the others' lists with it", async () => {
    const { first, second } = await ownerOfTwo();
    const here = await listed(first);
    await listed(second);
    for (const table of [company, person, contactDetail]) expect(await refusalOf(withWorkspace(db, second, (tx) => tx.delete(table)))).toContain("permission denied");
    expect(await prospectsOf(db, first, here.listId)).toHaveLength(1);
  });
});

describe("what one workspace found", () => {
  it("is found by another without a new lookup, with its people and how to reach them", async () => {
    const { first, second } = await ownerOfTwo();
    const here = await listed(first);
    await published(first, here.prospectId);
    const listId = await createList(db, second, "Leur liste");

    expect(await searchDirectory(db, second, "ACME")).toMatchObject([{ siren: "900000001", name: "ACME HOLDING", held: true, people: [{ firstName: "Jeanne", contacts: [{ value: "jeanne@acme.example", page: "https://acme.example/contact" }] }] }]);
    expect(await addCompanies(noLookups, second, listId, ["900000001"])).toEqual({ added: 1, skipped: [], notFound: [] });
    expect(await prospectsOf(db, second, listId)).toMatchObject([{ firstName: "Jeanne", personId: here.personId, company: "ACME HOLDING" }]);
  });

  it("is what a search kept, without anyone adding it to a list", async () => {
    const { first, second } = await ownerOfTwo();
    const search = registry(holding("900000001"));
    expect(await findCompanies(asking(search), first, "ACME")).toMatchObject({ from: "registry", companies: [{ siren: "900000001", held: false }] });
    expect(search.calls).toHaveLength(1);
    expect(await findCompanies(noLookups, second, "ACME")).toMatchObject({ from: "directory", companies: [{ siren: "900000001", held: true, people: [{ firstName: "Jeanne" }] }] });
  });

  it("goes to the registry too when the member asks, and says what was already held", async () => {
    const { first } = await ownerOfTwo();
    await listed(first);
    const search = registry(holding("900000001"), holding("900000002", { nom_complet: "ACME CONSEIL" }));
    const found = await findCompanies(asking(search), first, "ACME", true);
    expect(found.companies.map(({ siren, held }) => [siren, held])).toEqual([["900000001", true], ["900000002", false]]);
    expect(search.calls).toHaveLength(1);
  });

  it("isn't kept when it refused commercial use of its data, nor its directors", async () => {
    const { first } = await ownerOfTwo();
    const found = await findCompanies(asking(registry(holding("900000003", { opposition_diffusion_commerciale: true }))), first, "ACME");
    expect(found.companies).toMatchObject([{ siren: "900000003", mayBeProspected: false, held: false }]);
    expect(await withWorkspace(db, first, (tx) => tx.select().from(company))).toEqual([]);
    expect(await withWorkspace(db, first, (tx) => tx.select().from(person))).toEqual([]);
  });

  it("treats someone a file brought as a director once the registry names them, for every workspace", async () => {
    const { first, second } = await ownerOfTwo();
    const fromFile = await createList(db, first, "Fichier");
    await importProspects(asking(registry(holding())), first, fromFile, readProspectsCsv("prénom,nom,société,siren\nJeanne,Dupont-Martin,ACME,900000001\n"));
    await addCompanies(asking(registry(holding())), first, fromFile, ["900000001"]);
    const [{ personId }] = await prospectsOf(db, first, fromFile);
    expect(await db.select({ source: person.source, role: person.role }).from(person).where(eq(person.id, personId))).toEqual([{ source: "registry", role: "Président de SAS" }]);
    const listId = await createList(db, second, "Leur liste");
    expect(await addCompanies(noLookups, second, listId, ["900000001"])).toMatchObject({ added: 1 });
    expect(await prospectsOf(db, second, listId)).toMatchObject([{ personId }]);
  });

  it("searches by the words as written: % and _ match nothing but themselves", async () => {
    const { first } = await ownerOfTwo();
    await listed(first);
    expect(await searchDirectory(db, first, "%%")).toEqual([]);
    expect(await searchDirectory(db, first, "A_ME")).toEqual([]);
    expect(await searchDirectory(db, first, "a")).toEqual([]);
    expect(await searchDirectory(db, first, "900 000 001")).toHaveLength(1);
  });
});

describe("what the registry said", () => {
  const later = (days: number): Services => ({ ...noLookups, now: () => new Date(Date.now() + days * DAY_MS) });

  it("stops standing in for asking again after a while: a company can refuse at any time", async () => {
    const { first, second } = await ownerOfTwo();
    await listed(first);
    expect((await lookUpCompanies(later(20), second, ["900000001"])).has("900000001")).toBe(true);
    const fake = registry(holding("900000001"));
    await lookUpCompanies({ ...later(31), fetch: fake.fetch }, second, ["900000001"]);
    expect(fake.calls).toHaveLength(1);
  });

  it("reaches every workspace when a company now refuses", async () => {
    const { first, second } = await ownerOfTwo();
    const here = await listed(first);
    const fake = registry(holding("900000001", { opposition_diffusion_commerciale: true }));
    const result = await addCompanies({ ...later(31), fetch: fake.fetch }, second, await createList(db, second, "Leur liste"), ["900000001"]);
    expect(result).toMatchObject({ added: 0, skipped: [{ why: "refused commercial use of its data" }] });
    expect(await addCompanies(noLookups, first, here.listId, ["900000001"])).toMatchObject({ skipped: [{ why: "refused commercial use of its data" }] });
    expect((await searchDirectory(db, first, "900000001"))[0].mayBeProspected).toBe(false);
  });

  it("makes the next workspace ask again when a company closed", async () => {
    const { first, second } = await ownerOfTwo();
    await listed(first);
    const fake = registry(holding("900000001", { etat_administratif: "C" }));
    expect(await addCompanies({ ...later(31), fetch: fake.fetch }, second, await createList(db, second, "Leur liste"), ["900000001"])).toMatchObject({ skipped: [{ why: "closed" }] });
    const again = registry(holding("900000001", { etat_administratif: "C" }));
    await lookUpCompanies(asking(again), first, ["900000001"]);
    expect(again.calls).toHaveLength(1);
  });

  it("doesn't age by being reused: only the registry's word starts the clock again", async () => {
    const { first, second } = await ownerOfTwo();
    await listed(first);
    const [{ checkedAt }] = await db.select({ checkedAt: company.registryCheckedAt }).from(company).where(eq(company.directoryId, await directoryOf(first)));
    await addCompanies(noLookups, second, await createList(db, second, "Leur liste"), ["900000001"]);
    const [{ checkedAt: after }] = await db.select({ checkedAt: company.registryCheckedAt }).from(company).where(eq(company.directoryId, await directoryOf(first)));
    expect(after).toEqual(checkedAt);
  });
});

describe("a plain member of one workspace of a directory", () => {
  /** An owner's two workspaces, and someone invited to the second only. */
  async function invited() {
    const owner = await ownerOfTwo();
    const memberId = await someone();
    await db.insert(member).values({ workspaceId: owner.second, userId: memberId, role: "member" });
    const here = await listed(owner.first);
    await published(owner.first, here.prospectId);
    const workspaces = await workspacesOf(db, memberId);
    return { ...owner, here, memberId, workspaces, call: clientAs(memberId, workspaces) };
  }

  it("belongs only to that one", async () => {
    const { second, workspaces } = await invited();
    expect(workspaces).toEqual([{ id: second, name: "Contoso", role: "member", group: "Northwind" }]);
  });

  it("finds a shared company by looking for it, with its published details: that's what it's there for", async () => {
    const { call } = await invited();
    expect((await call("search_group", { words: "900000001" })).structuredContent).toMatchObject({ companies: [{ siren: "900000001", people: [{ contacts: [{ value: "jeanne@acme.example" }] }] }] });
  });

  it("has no tool that lists the directory: nothing answers without being asked about a company", async () => {
    const { call } = await invited();
    expect((await call("search_group", {})).isError).toBe(true);
    expect((await call("search_group", { words: "" })).isError).toBe(true);
    expect((await call("list_lists")).structuredContent).toEqual({ lists: [] });
  });

  it("sees nothing of the other workspace's lists, conversations or messages, and can't name it", async () => {
    const { first, here, call } = await invited();
    expect((await call("list_prospects", { listId: here.listId })).structuredContent).toEqual({ prospects: [] });
    expect((await call("read_thread", { prospectId: here.prospectId })).isError).toBe(true);
    expect((await call("list_lists", { workspace: first })).isError).toBe(true);
    expect((await call("list_lists", { workspace: "Northwind" })).isError).toBe(true);
  });

  it("is told of another workspace's writing by its name and a date, and no more", async () => {
    const { first, second, here, userId, call } = await invited();
    const seen = await everyKindOfRow(first, userId, "northwind", "900000005");
    const listId = await createList(db, second, "Leur liste");
    const added = (await call("add_companies_to_list", { listId, sirens: ["900000005"] })).structuredContent;
    expect(added.elsewhere).toEqual([{ personId: seen.personId, person: "Jeanne Dupont-Martin", workspace: "Northwind", writtenAt: NOW.toISOString(), optedOutAt: null }]);
    expect(JSON.stringify(added)).not.toContain("message body");
    expect(here.personId).not.toBe(seen.personId);
  });

  it("is out of all of it once removed", async () => {
    const { second, userId, memberId } = await invited();
    await removeMember(db, second, userId, memberId);
    expect(await workspacesOf(db, memberId)).toEqual([]);
  });
});

describe("someone another workspace of the directory reached", () => {
  async function writtenToFromFirst() {
    const owner = await ownerOfTwo();
    const here = await listed(owner.first);
    await published(owner.first, here.prospectId);
    await withWorkspace(db, owner.first, async (tx) => {
      const [{ companyId }] = await tx.select({ companyId: person.companyId }).from(person).where(eq(person.id, here.personId));
      const [campaign] = await tx.insert(sequence).values({ name: "Campagne", window: { days: [1], from: "09:00", to: "17:00", timezone: "Europe/Paris" } }).returning({ id: sequence.id });
      const [enrolled] = await tx.insert(enrollment).values({ sequenceId: campaign.id, prospectId: here.prospectId, personId: here.personId, companyId }).returning({ id: enrollment.id });
      await tx.insert(stepMessage).values({ enrollmentId: enrolled.id, channel: "email", subject: "Sujet confidentiel", body: "Texte confidentiel", status: "sent", sentAt: NOW });
      await tx.insert(outreach).values({ channel: "email", address: "jeanne@acme.example", enrollmentId: enrolled.id, sentAt: NOW });
      await tx.insert(signal).values({ type: "replied", channel: "email", externalId: "reply-1", address: "jeanne@acme.example", at: NOW, detail: "Réponse confidentielle" });
    });
    return { ...owner, here };
  }

  it("is pointed out when added to a list, with the workspace and when, and isn't refused", async () => {
    const { second, here } = await writtenToFromFirst();
    const listId = await createList(db, second, "Leur liste");
    const added = await addCompanies(noLookups, second, listId, ["900000001"]);
    expect(added).toMatchObject({ added: 1, elsewhere: [{ personId: here.personId, person: "Jeanne Dupont-Martin", workspace: "Northwind", writtenAt: NOW, optedOutAt: null }] });
    expect(await prospectsOf(db, second, listId)).toHaveLength(1);
  });

  it("is pointed out when a file adds them", async () => {
    const { second, here } = await writtenToFromFirst();
    const listId = await createList(db, second, "Fichier");
    const imported = await importProspects(noLookups, second, listId, readProspectsCsv("prénom,nom,société,siren\nJeanne,Dupont-Martin,ACME HOLDING,900000001\n"));
    expect(imported).toMatchObject({ added: 1, elsewhere: [{ personId: here.personId, workspace: "Northwind", writtenAt: NOW }] });
  });

  it("is pointed out by the assistant's list and the directory's search too", async () => {
    const { second, userId } = await writtenToFromFirst();
    const listId = await createList(db, second, "Leur liste");
    await addCompanies(noLookups, second, listId, ["900000001"]);
    const call = clientAs(userId, [{ id: second, name: "Contoso", role: "owner", group: "Northwind" }]);
    expect((await call("list_prospects", { listId })).structuredContent).toMatchObject({ prospects: [{ elsewhere: [{ workspace: "Northwind", writtenAt: NOW.toISOString(), optedOutAt: null }] }] });
    expect((await call("search_group", { words: "ACME" })).structuredContent).toMatchObject({ companies: [{ people: [{ elsewhere: [{ workspace: "Northwind" }] }] }] });
  });

  it("isn't pointed out to the workspace that wrote, nor when nobody did", async () => {
    const { first, here, second } = await writtenToFromFirst();
    expect(await elsewhereOf(db, first, [here.personId])).toEqual([]);
    const fresh = await listed(second, "900000002");
    expect(await elsewhereOf(db, second, [fresh.personId])).toEqual([]);
    expect(await addCompanies(noLookups, second, fresh.listId, ["900000002"])).toEqual({ added: 0, skipped: [], notFound: [] });
  });

  it("keeps what was written and answered closed: not in the note, not in the thread", async () => {
    const { second, here } = await writtenToFromFirst();
    const listId = await createList(db, second, "Leur liste");
    await addCompanies(noLookups, second, listId, ["900000001"]);
    const [{ id: prospectId }] = await prospectsOf(db, second, listId);
    const told = JSON.stringify([await elsewhereOf(db, second, [here.personId]), await threadOf(db, second, prospectId), await searchDirectory(db, second, "ACME")]);
    expect(told).not.toContain("confidentiel");
    expect(told).not.toContain("confidentielle");
    expect(await threadOf(db, second, prospectId)).toMatchObject({ items: [] });
  });

  it("says whom they opted out of and when, without stopping anyone", async () => {
    const { first, second, here } = await writtenToFromFirst();
    await suppress(db, first, "jeanne@acme.example", "asked");
    const listId = await createList(db, second, "Leur liste");
    const added = await addCompanies(noLookups, second, listId, ["900000001"]);
    expect(added).toMatchObject({ added: 1, elsewhere: [{ personId: here.personId, workspace: "Northwind", optedOutAt: expect.any(Date) }] });
    expect(await suppressedOf(db, second)).toEqual([]);
  });

  it("isn't told of a workspace's own exclusion: that's not the person asking", async () => {
    const { first, second, here } = await ownerOfTwo().then(async (owner) => ({ ...owner, here: await listed(owner.first) }));
    await published(first, here.prospectId);
    await suppress(db, first, "acme.example", "member");
    expect(await elsewhereOf(db, second, [here.personId])).toEqual([]);
    expect(await suppressedOf(db, second)).toEqual([]);
  });

  it("is told of an opt-out by a whole domain as well as by an address", async () => {
    const { first, second, here } = await ownerOfTwo().then(async (owner) => ({ ...owner, here: await listed(owner.first) }));
    await published(first, here.prospectId);
    await suppress(db, first, "acme.example", "asked");
    expect(await elsewhereOf(db, second, [here.personId])).toMatchObject([{ workspace: "Northwind", optedOutAt: expect.any(Date), writtenAt: null }]);
  });

  it("reads as French", async () => {
    const { elsewhereInWords, elsewhereWithName } = await import("@/domain/directory");
    const note = { personId: "1", person: "Jeanne Martin", workspace: "Northwind", writtenAt: NOW, optedOutAt: NOW };
    expect(elsewhereInWords(note)).toBe("Cette personne a été contactée depuis Northwind le 6 novembre 2026, et a demandé à Northwind de ne plus la contacter le 6 novembre 2026.");
    expect(elsewhereInWords({ ...note, optedOutAt: null })).toBe("Cette personne a été contactée depuis Northwind le 6 novembre 2026.");
    expect(elsewhereInWords({ ...note, writtenAt: null })).toBe("Cette personne a demandé à Northwind de ne plus la contacter le 6 novembre 2026.");
    expect(elsewhereWithName({ ...note, optedOutAt: null })).toBe("Jeanne Martin : a été contactée depuis Northwind le 6 novembre 2026.");
    for (const said of [elsewhereInWords(note), elsewhereWithName(note)]) expectFrenchTypography(said);
  });
});

describe("one owner's two groups", () => {
  it("share nothing, whoever owns them: it's the group that shares, not the owner", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db, "Northwind");
    const apart = await createWorkspace(db, userId, "Contoso");
    const here = await listed(workspaceId);
    await published(workspaceId, here.prospectId);
    expect(await searchDirectory(db, apart, "ACME")).toEqual([]);
    expect(await contactsOf(db, apart, [here.personId])).toEqual([]);
    const fake = registry(holding());
    await addCompanies(asking(fake), apart, await createList(db, apart, "Leur liste"), ["900000001"]);
    expect(fake.calls).toHaveLength(1);
    expect(await withWorkspace(db, apart, (tx) => tx.select().from(company))).toHaveLength(1);
    expect(await withWorkspace(db, workspaceId, (tx) => tx.select().from(company))).toHaveLength(1);
    expect((await withWorkspace(db, apart, (tx) => tx.select({ id: company.id }).from(company)))[0].id).not.toBe((await withWorkspace(db, workspaceId, (tx) => tx.select({ id: company.id }).from(company)))[0].id);
  });
});

describe("which group a new workspace joins", () => {
  it("is a new one, named after it, unless someone says otherwise: even for someone who owns a group", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db, "Northwind");
    const started = await createWorkspace(db, userId, "Contoso");
    expect(await directoryOf(started)).not.toBe(await directoryOf(workspaceId));
    expect(await groupOf(db, started)).toMatchObject({ name: "Contoso" });
    expect(await groupsOwnedBy(db, userId)).toHaveLength(2);
  });

  it("is one of theirs when its founder names it, and one owner can run several", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db, "Northwind");
    const elsewhere = await createWorkspace(db, userId, "Contoso");
    const joined = await createWorkspace(db, userId, "Northwind Studio", await directoryOf(workspaceId));
    expect(await directoryOf(joined)).toBe(await directoryOf(workspaceId));
    expect(await directoryOf(joined)).not.toBe(await directoryOf(elsewhere));
    expect((await groupsOwnedBy(db, userId)).map(({ name }) => name)).toEqual(["Contoso", "Northwind"]);
  });

  const ADMINS = { COLDLYNE_ADMINS: "founder@example.com" };
  const founder = (userId: string) => ({ userId, email: "founder@example.com" });

  it("is refused to someone who owns no workspace of it, and nothing is started", async () => {
    const theirs = await createTestWorkspace(db, "Theirs");
    const stranger = await someone();
    expect(await startWorkspace(db, ADMINS, founder(stranger), "Mine", await directoryOf(theirs.workspaceId))).toBeNull();
    expect(await workspacesOf(db, stranger)).toEqual([]);
    await expect(createWorkspace(db, stranger, "Mine", await directoryOf(theirs.workspaceId))).rejects.toThrow("isn't theirs");
  });

  it("is refused to a plain member or an admin of it: only an owner adds to a group", async () => {
    for (const role of ["member", "admin"] as const) {
      const { workspaceId } = await createTestWorkspace(db, "Theirs");
      const invitee = await someone();
      await db.insert(member).values({ workspaceId, userId: invitee, role });
      expect(await groupsOwnedBy(db, invitee)).toEqual([]);
      expect(await startWorkspace(db, ADMINS, founder(invitee), "Mine", await directoryOf(workspaceId))).toBeNull();
    }
  });

  it("isn't reached by naming something that isn't a group", async () => {
    const { userId } = await createTestWorkspace(db, "Northwind");
    expect(await startWorkspace(db, ADMINS, founder(userId), "Mine", "not-a-group")).toBeNull();
    expect(await startWorkspace(db, ADMINS, founder(userId), "Mine", crypto.randomUUID())).toBeNull();
  });

  it("can be joined by someone made owner of a workspace of it, who could already let anyone in there, but never by default", async () => {
    const customer = await ownerOfTwo();
    const invitee = await someone();
    await db.insert(member).values({ workspaceId: customer.first, userId: invitee, role: "member" });
    expect(await changeRole(db, customer.first, customer.userId, invitee, "owner")).toMatchObject({ ok: true });
    expect(await directoryOf(await createWorkspace(db, invitee, "Their own company"))).not.toBe(await directoryOf(customer.first));
    expect(await directoryOf(await createWorkspace(db, invitee, "With them", await directoryOf(customer.first)))).toBe(await directoryOf(customer.first));
  });

  it("can't be one they've left: no way back into what they no longer own", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db, "Sold");
    const buyer = await someone();
    await db.insert(member).values({ workspaceId, userId: buyer, role: "owner" });
    expect(await removeMember(db, workspaceId, userId, userId)).toMatchObject({ ok: true });
    expect(await groupsOwnedBy(db, userId)).toEqual([]);
    expect(await startWorkspace(db, ADMINS, founder(userId), "Next venture", await directoryOf(workspaceId))).toBeNull();
    expect(await directoryOf(await createWorkspace(db, buyer, "Buyer's own", await directoryOf(workspaceId)))).toBe(await directoryOf(workspaceId));
  });

  it("stays a new group for each of two started at once", async () => {
    const newcomer = await someone();
    const [one, two] = await Promise.all([createWorkspace(db, newcomer, "One"), createWorkspace(db, newcomer, "Two")]);
    expect(await directoryOf(one)).not.toBe(await directoryOf(two));
  });
});

describe("a group's name", () => {
  it("is changed by whoever owns a workspace of it, for every workspace of it", async () => {
    const { first, second, userId } = await ownerOfTwo();
    expect(await renameGroup(db, second, userId, "  Le groupe  ")).toEqual({ ok: true, said: "Enregistré." });
    expect(await groupOf(db, first)).toMatchObject({ name: "Le groupe" });
    expect((await workspacesOf(db, userId)).map(({ group }) => group)).toEqual(["Le groupe", "Le groupe"]);
  });

  it("isn't changed by a plain member, an admin, or anyone else, and can't be empty", async () => {
    const { first, second, userId } = await ownerOfTwo();
    const [plain, admin, stranger] = [await someone(), await someone(), await someone()];
    await db.insert(member).values([{ workspaceId: second, userId: plain, role: "member" }, { workspaceId: second, userId: admin, role: "admin" }]);
    for (const actor of [plain, admin, stranger]) expect(await renameGroup(db, second, actor, "Le leur")).toMatchObject({ ok: false, error: expect.stringContaining("propriétaire") });
    expect(await renameGroup(db, second, userId, "   ")).toMatchObject({ ok: false });
    expect(await groupOf(db, first)).toMatchObject({ name: "Northwind" });
  });

  it("reads as French when refused", async () => {
    const { second } = await ownerOfTwo();
    for (const answer of [await renameGroup(db, second, await someone(), "x"), await renameGroup(db, second, await someone(), " ")]) expectFrenchTypography((answer as { error: string }).error);
  });
});

describe("removing someone or something", () => {
  it("takes a member out and leaves the directory as it was", async () => {
    const { first, second, userId } = await ownerOfTwo();
    const mate = await someone();
    await db.insert(member).values({ workspaceId: second, userId: mate, role: "admin" });
    const here = await listed(first);
    const before = await directoryOf(second);
    expect(await removeMember(db, second, userId, mate)).toMatchObject({ ok: true });
    expect(await directoryOf(second)).toBe(before);
    expect(await searchDirectory(db, second, "900000001")).toHaveLength(1);
    expect(await prospectsOf(db, first, here.listId)).toHaveLength(1);
  });

  it("keeps the shared rows when an owner leaves one workspace and still owns another", async () => {
    const { first, second, userId } = await ownerOfTwo();
    const heir = await someone();
    await db.insert(member).values({ workspaceId: second, userId: heir, role: "owner" });
    await listed(second);
    expect(await removeMember(db, second, userId, userId)).toMatchObject({ ok: true });
    const third = await createWorkspace(db, userId, "Third", await directoryOf(first));
    expect(await directoryOf(third)).toBe(await directoryOf(first));
    expect(await searchDirectory(db, third, "900000001")).toHaveLength(1);
  });

  it("leaves what a removed workspace found to the others, and its own things out of their reach", async () => {
    const { first, second, userId } = await ownerOfTwo();
    const here = await listed(first);
    await published(first, here.prospectId);
    const there = await listed(second);
    await suppress(db, first, "bounces@acme.example", "member");
    await withWorkspace(db, first, (tx) => tx.insert(suppression).values({ value: "dead@acme.example", reason: "bounced" }));
    await db.delete(workspace).where(eq(workspace.id, first));

    expect(await db.select().from(member).where(eq(member.workspaceId, first))).toEqual([]);
    expect(await workspacesOf(db, userId)).toHaveLength(1);
    // What it found stays: another workspace is working from it.
    expect(await contactsOf(db, second, [there.personId])).toMatchObject([{ value: "jeanne@acme.example" }]);
    expect(await prospectsOf(db, second, there.listId)).toHaveLength(1);
    // Nobody is named after it any more, and nothing of its own is read.
    expect(await elsewhereOf(db, second, [there.personId])).toEqual([]);
    expect(await suppressedOf(db, second)).toEqual([]);
  });

  it("can't remove a directory that still has a workspace", async () => {
    const { first } = await ownerOfTwo();
    expect(await refusalOf(db.delete(directory).where(eq(directory.id, await directoryOf(first))))).toContain("foreign key");
  });

  it("leaves a group in place when its owner's account goes, and nobody who can add to it", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const before = await directoryOf(workspaceId);
    await db.delete(user).where(eq(user.id, userId));
    expect(await directoryOf(workspaceId)).toBe(before);
    expect(await groupsOwnedBy(db, userId)).toEqual([]);
  });
});

describe("moving a workspace between directories", () => {
  it("isn't something accepting an invitation does, to either side", async () => {
    const inviter = await ownerOfTwo();
    const guest = await createTestWorkspace(db, "Guest's own");
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, guest.userId));
    const [before, guestBefore] = [await directoryOf(inviter.first), await directoryOf(guest.workspaceId)];
    const [{ email }] = await db.select({ email: user.email }).from(user).where(eq(user.id, guest.userId));
    const invited = await inviteToWorkspace(noLookups, inviter.first, inviter.userId, email, "admin");
    if (!invited.ok || !invited.link) throw new Error("No link to accept");
    const token = decodeURIComponent(invited.link.split("/join/")[1]);
    expect(await acceptInvitation(db, guest.userId, token, NOW)).toMatchObject({ ok: true });
    expect(await directoryOf(inviter.first)).toBe(before);
    expect(await directoryOf(guest.workspaceId)).toBe(guestBefore);
    expect(before).not.toBe(guestBefore);
  });

  it("isn't open to the app role, whoever is asking", async () => {
    const { first } = await ownerOfTwo();
    const other = await createTestWorkspace(db, "Other");
    const theirs = await directoryOf(other.workspaceId);
    expect(await refusalOf(withWorkspace(db, first, (tx) => tx.update(workspace).set({ directoryId: theirs }).where(eq(workspace.id, first))))).toContain("permission denied");
    expect(await refusalOf(withWorkspace(db, first, (tx) => tx.insert(directory).values({ name: "Planted" })))).toContain("permission denied");
    expect(await refusalOf(withWorkspace(db, first, (tx) => tx.insert(member).values({ workspaceId: other.workspaceId, userId: other.userId })))).toContain("permission denied");
  });

  it("isn't offered by any tool", async () => {
    const { first, userId } = await ownerOfTwo();
    const handler = createMcpHandler(() => coldlyneServer({ services: noLookups, userId, workspaces: [{ id: first, name: "Northwind", role: "owner", group: "Northwind" }] }));
    const response = await handler.fetch(new Request("https://coldlyne.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }));
    const text = await response.text();
    const { tools } = JSON.parse(text.startsWith("{") ? text : (text.split("\n").find((line) => line.startsWith("data: ")) ?? "").slice(6)).result;
    const inputs = tools.map(({ name, inputSchema }: { name: string; inputSchema: unknown }) => `${name} ${JSON.stringify(inputSchema)}`).join("\n");
    expect(inputs).not.toMatch(/directoryId|directory_id/);
    expect(tools.find(({ name }: { name: string }) => name === "search_group").annotations.readOnlyHint).toBe(true);
    // The product's word is "group", whatever the code calls it.
    expect(JSON.stringify(tools)).not.toMatch(/directory/i);
  });

  it("isn't something starting a sequence or saving a setting can do by accident", async () => {
    const { first, userId } = await ownerOfTwo();
    const before = await directoryOf(first);
    await saveSettings(db, first, { senderName: "Northwind" });
    expect((await createSequence(noLookups, first, userId, { name: "Campagne", steps: [] })).ok).toBe(true);
    expect(await directoryOf(first)).toBe(before);
  });
});
