import { and, eq, ilike, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { onePerDetail } from "@/domain/contacts";
import { registryFactsStillGood, type ElsewhereNote } from "@/domain/directory";
import { prospectable, type RegistryCompany } from "@/domain/registry";
import type { Database } from "@/infrastructure/db/client";
import { company, contactDetail, person } from "@/infrastructure/db/schema/prospects";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { companiesBySiren, searchRegistry } from "@/infrastructure/registry/client";
import type { Services } from "./services";

/**
 * What a directory (a group, on the screens and in the tools) holds: companies and the people at them,
 * found once for all its workspaces. Row-level security keeps it to the bound workspace's directory.
 * Nothing here lists a directory as a whole: it answers about a company someone is looking for, so a
 * member of one business can't read off who the group's other businesses are after.
 */

/** The order to try someone's details in: what this workspace brought itself, then what others of its group found. */
export const ownDetailsFirst = [sql`(${contactDetail.workspaceId} = app_workspace_id()) desc`, contactDetail.createdAt] as const;

/** The company's row, new or brought up to date with what the registry just said. One row per SIREN in a directory. */
export async function upsertCompany(tx: Database, found: RegistryCompany): Promise<string> {
  const values = { siren: found.siren, name: found.name, legalForm: found.legalForm, activity: found.activity, street: found.street, postcode: found.postcode, city: found.city, createdOn: found.createdOn, registryOptOut: found.registryOptOut, registryCheckedAt: found.checkedAt ?? sql`now()`, source: "registry" as const };
  const [row] = await tx
    .insert(company)
    .values(values)
    .onConflictDoUpdate({ target: [company.directoryId, company.siren], set: { ...values, updatedAt: sql`now()` } })
    .returning({ id: company.id });
  return row.id;
}

/** The person's row, matched by company and exact name. The registry naming someone a file already brought says where they come from. */
export async function upsertPerson(tx: Database, companyId: string, director: RegistryCompany["directors"][number]): Promise<string> {
  const match = and(eq(person.companyId, companyId), director.firstName === null ? sql`${person.firstName} is null` : eq(person.firstName, director.firstName), eq(person.lastName, director.lastName));
  const [existing] = await tx.select({ id: person.id, source: person.source }).from(person).where(match);
  if (existing) {
    if (existing.source !== "registry") await tx.update(person).set({ source: "registry", role: sql`coalesce(${person.role}, ${director.role})` }).where(eq(person.id, existing.id));
    return existing.id;
  }
  const [row] = await tx.insert(person).values({ companyId, firstName: director.firstName, lastName: director.lastName, role: director.role, source: "registry" }).returning({ id: person.id });
  return row.id;
}

/** A company the registry describes joins the directory with its directors; one that can't be prospected isn't kept. */
async function rememberOne(tx: Database, found: RegistryCompany): Promise<void> {
  if (!prospectable(found)) return noteRefusal(tx, found);
  const companyId = await upsertCompany(tx, found);
  for (const director of found.directors.filter(({ kind }) => kind === "person")) await upsertPerson(tx, companyId, director);
}

/** What the registry says now of a company the directory already holds. One it doesn't hold stays out: there's no reason to keep it. */
async function noteRefusal(tx: Database, found: RegistryCompany): Promise<void> {
  // A closed company isn't marked as such anywhere: no date means the next workspace asks again, and hears it.
  await tx.update(company).set({ registryOptOut: found.registryOptOut, registryCheckedAt: found.active ? sql`now()` : null }).where(eq(company.siren, found.siren));
}

/** What a search found goes in the directory, without duplicates. It shows on no list until a workspace adds it. */
export async function rememberCompanies(db: Database, workspaceId: string, companies: readonly RegistryCompany[]): Promise<void> {
  await withWorkspace(db, workspaceId, async (tx) => {
    for (const found of companies) await rememberOne(tx, found);
  });
}

const FIELDS = { id: company.id, siren: company.siren, name: company.name, legalForm: company.legalForm, activity: company.activity, street: company.street, postcode: company.postcode, city: company.city, createdOn: company.createdOn, registryOptOut: company.registryOptOut, checkedAt: company.registryCheckedAt };

/** These companies as the directory holds them, while what the registry said is still good. */
async function heldBySiren(services: Services, workspaceId: string, sirens: readonly string[]): Promise<Map<string, RegistryCompany>> {
  if (sirens.length === 0) return new Map();
  return withWorkspace(services.db, workspaceId, async (tx) => {
    const rows = (await tx.select(FIELDS).from(company).where(inArray(company.siren, [...sirens]))).filter(({ checkedAt }) => registryFactsStillGood(checkedAt, services.now()));
    const directors = rows.length ? await tx.select({ companyId: person.companyId, firstName: person.firstName, lastName: person.lastName, role: person.role }).from(person).where(and(inArray(person.companyId, rows.map(({ id }) => id)), eq(person.source, "registry"))) : [];
    return new Map(
      rows.map(({ id, siren, ...row }) => [
        siren as string,
        { ...row, siren: siren as string, active: true, checkedAt: row.checkedAt as Date, directors: directors.filter(({ companyId }) => companyId === id).map(({ firstName, lastName, role }) => ({ kind: "person" as const, firstName, lastName, role })) },
      ]),
    );
  });
}

/**
 * These companies by their SIREN, from the directory when another workspace's lookup is recent enough,
 * otherwise from the registry; one neither knows is left out. A refusal the registry just voiced is
 * kept on the company's row, for every workspace.
 */
export async function lookUpCompanies(services: Services, workspaceId: string, sirens: readonly string[]): Promise<Map<string, RegistryCompany>> {
  const held = await heldBySiren(services, workspaceId, [...new Set(sirens)]);
  const asked = await companiesBySiren(sirens.filter((siren) => !held.has(siren)), services.fetch);
  const refusing = [...asked.values()].filter((found) => !prospectable(found));
  if (refusing.length) await rememberCompanies(services.db, workspaceId, refusing);
  return new Map([...held, ...asked]);
}

export interface KnownPerson {
  id: string;
  firstName: string | null;
  lastName: string;
  role: string | null;
  contacts: { kind: string; value: string; page: string | null }[];
  elsewhere: ElsewhereNote[];
}

export interface KnownCompany {
  siren: string | null;
  name: string;
  legalForm: string | null;
  activity: string | null;
  postcode: string | null;
  city: string | null;
  mayBeProspected: boolean;
  /** Whether it was already there: nobody had to look it up again. */
  held: boolean;
  people: KnownPerson[];
}

const MOST_FOUND = 25;

/** A LIKE pattern for these words as they're written, % and _ included. */
const containing = (words: string) => `%${words.replace(/[\\%_]/g, "\\$&")}%`;

const askingFor = (words: string): SQL => {
  const digits = words.replace(/\s/g, "");
  return /^\d{9}$/.test(digits) ? eq(company.siren, digits) : ilike(company.name, containing(words.trim()));
};

async function withPeople(tx: Database, rows: { id: string; siren: string | null; name: string; legalForm: string | null; activity: string | null; postcode: string | null; city: string | null; registryOptOut: boolean }[]): Promise<KnownCompany[]> {
  if (rows.length === 0) return [];
  const people = await tx.select({ id: person.id, companyId: person.companyId, firstName: person.firstName, lastName: person.lastName, role: person.role }).from(person).where(inArray(person.companyId, rows.map(({ id }) => id)));
  const ids = people.map(({ id }) => id);
  const details = ids.length ? await tx.select({ personId: contactDetail.personId, kind: contactDetail.kind, value: contactDetail.value, page: contactDetail.page }).from(contactDetail).where(inArray(contactDetail.personId, ids)).orderBy(...ownDetailsFirst) : [];
  const elsewhere = await elsewhereAmong(tx, ids);
  return rows.map(({ id, registryOptOut, ...row }) => ({
    ...row,
    mayBeProspected: !registryOptOut,
    held: true,
    people: people
      .filter(({ companyId }) => companyId === id)
      .map(({ id: personId, firstName, lastName, role }) => ({ id: personId, firstName, lastName, role, contacts: onePerDetail(details.filter((detail) => detail.personId === personId)).map(({ kind, value, page }) => ({ kind, value, page })), elsewhere: elsewhere.filter((note) => note.personId === personId) })),
  }));
}

/** The companies the directory already holds by this SIREN or name, with their people and how to reach them: no lookup, nothing listed unasked. */
export async function searchDirectory(db: Database, workspaceId: string, words: string): Promise<KnownCompany[]> {
  if (words.trim().length < 2) return [];
  return withWorkspace(db, workspaceId, async (tx) => withPeople(tx, await tx.select(FIELDS).from(company).where(askingFor(words)).orderBy(company.name).limit(MOST_FOUND)));
}

const fromRegistryOnly = (found: RegistryCompany): KnownCompany => ({
  siren: found.siren,
  name: found.name,
  legalForm: found.legalForm,
  activity: found.activity,
  postcode: found.postcode,
  city: found.city,
  mayBeProspected: prospectable(found),
  held: false,
  people: found.directors.filter(({ kind }) => kind === "person").map(({ firstName, lastName, role }) => ({ id: "", firstName, lastName, role, contacts: [], elsewhere: [] })),
});

export interface CompaniesFound {
  from: "directory" | "registry";
  companies: KnownCompany[];
}

/**
 * What a member's search finds: what the directory holds if it holds any, without asking anyone
 * else, unless they ask for the registry too. What the registry finds goes in the directory.
 */
export async function findCompanies(services: Services, workspaceId: string, words: string, askRegistry = false): Promise<CompaniesFound> {
  const held = askRegistry ? [] : await searchDirectory(services.db, workspaceId, words);
  if (held.length) return { from: "directory", companies: held };
  const { companies } = await searchRegistry({ words: words.trim() }, services.fetch);
  if (companies.length === 0) return { from: "registry", companies: [] };
  const sirens = companies.map(({ siren }) => siren);
  const heldBefore = await withWorkspace(services.db, workspaceId, (tx) => tx.select({ siren: company.siren }).from(company).where(inArray(company.siren, sirens)));
  await rememberCompanies(services.db, workspaceId, companies);
  const kept = await withWorkspace(services.db, workspaceId, async (tx) => withPeople(tx, await tx.select(FIELDS).from(company).where(inArray(company.siren, sirens))));
  return { from: "registry", companies: companies.map((found) => ({ ...(kept.find(({ siren }) => siren === found.siren) ?? fromRegistryOnly(found)), held: heldBefore.some(({ siren }) => siren === found.siren) })) };
}

/**
 * A company without a SIREN, by its exact name, as an import matches it: this workspace's own row
 * first, so importing again finds the same company and the same people. Nothing proves two rows with
 * one name are one company, so the oldest of another workspace's is only a guess, for lack of its own.
 */
export async function companyNamed(tx: Database, name: string): Promise<string | undefined> {
  const [known] = await tx
    .select({ id: company.id })
    .from(company)
    .where(and(isNull(company.siren), eq(company.name, name)))
    .orderBy(sql`(${company.workspaceId} = app_workspace_id()) desc`, company.createdAt)
    .limit(1);
  return known?.id;
}

const momentOf = (value: unknown) => (value === null || value === undefined ? null : new Date(value as string));

/**
 * What the directory's other workspaces did with these people, so a member decides knowingly: who
 * wrote and when, who they opted out of and when. Only those bare facts leave the other workspace.
 */
export async function elsewhereAmong(tx: Database, personIds: readonly string[]): Promise<ElsewhereNote[]> {
  if (personIds.length === 0) return [];
  const people = sql.join(personIds.map((id) => sql`${id}`), sql`, `);
  return tx
    .select({
      personId: sql<string>`person_id`,
      person: sql<string>`person`,
      workspace: sql<string>`workspace`,
      writtenAt: sql<Date | null>`written_at`.mapWith(momentOf),
      optedOutAt: sql<Date | null>`opted_out_at`.mapWith(momentOf),
    })
    .from(sql`elsewhere_in_directory(ARRAY[${people}]::uuid[])`);
}

export const elsewhereOf = (db: Database, workspaceId: string, personIds: readonly string[]) => withWorkspace(db, workspaceId, (tx) => elsewhereAmong(tx, personIds));
