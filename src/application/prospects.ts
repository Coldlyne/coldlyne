import { and, count, desc, eq, sql } from "drizzle-orm";
import { prospectable, type RegistryCompany } from "@/domain/registry";
import type { Database } from "@/infrastructure/db/client";
import { company, person, prospect, prospectList, suppression } from "@/infrastructure/db/schema/prospects";
import { withWorkspace } from "@/infrastructure/db/tenant";

/** A new list of prospects. */
export async function createList(db: Database, workspaceId: string, name: string): Promise<string> {
  return withWorkspace(db, workspaceId, async (tx) => (await tx.insert(prospectList).values({ name: name.trim() }).returning({ id: prospectList.id }))[0].id);
}

export interface Added {
  /** People put on the list. */
  added: number;
  /** Companies left out, with why. */
  skipped: { siren: string; name: string; why: string }[];
}

/**
 * Puts the directors (people, not companies) of these registry companies on a list. A company
 * that refused commercial use of its data, or isn't active, is left out; a company or person
 * already known is reused, and someone already on the list isn't added twice.
 */
export async function addFromRegistry(db: Database, workspaceId: string, listId: string, companies: readonly RegistryCompany[]): Promise<Added> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const result: Added = { added: 0, skipped: [] };
    for (const found of companies) {
      const people = found.directors.filter((director) => director.kind === "person");
      if (!prospectable(found) || people.length === 0) {
        result.skipped.push({ siren: found.siren, name: found.name, why: !found.active ? "closed" : found.registryOptOut ? "refused commercial use of its data" : "no director who is a person" });
        continue;
      }
      const companyId = await upsertCompany(tx, found);
      for (const director of people) {
        const personId = await upsertPerson(tx, companyId, director);
        const inserted = await tx.insert(prospect).values({ listId, personId }).onConflictDoNothing().returning({ id: prospect.id });
        result.added += inserted.length;
      }
    }
    return result;
  });
}

async function upsertCompany(tx: Database, found: RegistryCompany): Promise<string> {
  const values = { siren: found.siren, name: found.name, legalForm: found.legalForm, activity: found.activity, street: found.street, postcode: found.postcode, city: found.city, createdOn: found.createdOn, registryOptOut: found.registryOptOut, source: "registry" as const };
  const [row] = await tx
    .insert(company)
    .values(values)
    .onConflictDoUpdate({ target: [company.workspaceId, company.siren], set: { ...values, updatedAt: sql`now()` } })
    .returning({ id: company.id });
  return row.id;
}

async function upsertPerson(tx: Database, companyId: string, director: RegistryCompany["directors"][number]): Promise<string> {
  const match = and(eq(person.companyId, companyId), director.firstName === null ? sql`${person.firstName} is null` : eq(person.firstName, director.firstName), eq(person.lastName, director.lastName));
  const [existing] = await tx.select({ id: person.id }).from(person).where(match);
  if (existing) return existing.id;
  const [row] = await tx.insert(person).values({ companyId, firstName: director.firstName, lastName: director.lastName, role: director.role, source: "registry" }).returning({ id: person.id });
  return row.id;
}

/** A list's prospects with their person and company, the latest added first. */
export async function prospectsOf(db: Database, workspaceId: string, listId: string) {
  return withWorkspace(db, workspaceId, (tx) =>
    tx
      .select({ id: prospect.id, personId: prospect.personId, state: prospect.state, firstName: person.firstName, lastName: person.lastName, role: person.role, companiesDirected: person.companiesDirected, company: company.name, siren: company.siren, city: company.city })
      .from(prospect)
      .innerJoin(person, eq(person.id, prospect.personId))
      .innerJoin(company, eq(company.id, person.companyId))
      .where(eq(prospect.listId, listId))
      .orderBy(sql`${prospect.createdAt} desc`),
  );
}

/** The workspace's lists, the latest first, with how many prospects each holds. */
export async function listsOf(db: Database, workspaceId: string) {
  return withWorkspace(db, workspaceId, (tx) =>
    tx
      .select({ id: prospectList.id, name: prospectList.name, createdAt: prospectList.createdAt, prospects: count(prospect.id) })
      .from(prospectList)
      .leftJoin(prospect, eq(prospect.listId, prospectList.id))
      .groupBy(prospectList.id)
      .orderBy(desc(prospectList.createdAt)),
  );
}

/** Never writes to this address or domain again, on any channel. Lowercased: the list is matched that way. */
export async function suppress(db: Database, workspaceId: string, value: string, reason: "asked" | "member" = "member"): Promise<void> {
  await withWorkspace(db, workspaceId, (tx) => tx.insert(suppression).values({ value: value.trim().toLowerCase(), reason }).onConflictDoNothing());
}

/** Who the workspace never writes to again, the latest first. */
export async function suppressedOf(db: Database, workspaceId: string) {
  return withWorkspace(db, workspaceId, (tx) => tx.select({ value: suppression.value, reason: suppression.reason, createdAt: suppression.createdAt }).from(suppression).orderBy(desc(suppression.createdAt)));
}
