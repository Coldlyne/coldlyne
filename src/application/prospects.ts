import { count, desc, eq, sql } from "drizzle-orm";
import type { ElsewhereNote } from "@/domain/directory";
import { prospectable, type RegistryCompany } from "@/domain/registry";
import type { Database } from "@/infrastructure/db/client";
import { company, person, prospect, prospectList, suppression } from "@/infrastructure/db/schema/prospects";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { elsewhereAmong, lookUpCompanies, upsertCompany, upsertPerson } from "./directory";
import { addToSuppressionList, ownSuppression, stopEveryoneAt, stopExcludedAt } from "./enrollments";
import type { Services } from "./services";

/** A new list of prospects. */
export async function createList(db: Database, workspaceId: string, name: string): Promise<string> {
  return withWorkspace(db, workspaceId, async (tx) => (await tx.insert(prospectList).values({ name: name.trim() }).returning({ id: prospectList.id }))[0].id);
}

export interface Added {
  /** People put on the list. */
  added: number;
  /** Companies left out, with why. */
  skipped: { siren: string; name: string; why: string }[];
  /** Those just added that another workspace of the directory wrote to, or who opted out of it: nothing stops them, a member decides. */
  elsewhere?: ElsewhereNote[];
}

/**
 * Puts the directors (people, not companies) of these registry companies on a list. A company
 * that refused commercial use of its data, or isn't active, is left out; a company or person
 * the directory already holds is reused, and someone already on the list isn't added twice.
 */
export async function addFromRegistry(db: Database, workspaceId: string, listId: string, companies: readonly RegistryCompany[]): Promise<Added> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const result: Added = { added: 0, skipped: [] };
    const addedPeople: string[] = [];
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
        if (inserted.length) addedPeople.push(personId);
      }
    }
    const elsewhere = await elsewhereAmong(tx, addedPeople);
    return elsewhere.length ? { ...result, elsewhere } : result;
  });
}

/** Puts these companies' directors on a list by SIREN, asking the registry only about what the directory can't answer for. */
export async function addCompanies(services: Services, workspaceId: string, listId: string, sirens: readonly string[]): Promise<Added & { notFound: string[] }> {
  const found = await lookUpCompanies(services, workspaceId, sirens);
  const added = await addFromRegistry(services.db, workspaceId, listId, [...found.values()]);
  return { ...added, notFound: sirens.filter((siren) => !found.has(siren)) };
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

/**
 * This workspace never writes to this address or domain again, on any channel, from any mailbox or
 * sending domain it has or connects later. Lowercased: the list is matched that way. Someone who asked
 * stops at once, as with a STOP, what was about to go to them included; the workspace's own exclusion
 * ("this domain is my client") stops them too, and leaves their colleagues be.
 */
export async function suppress(db: Database, workspaceId: string, value: string, reason: "asked" | "member" = "member"): Promise<void> {
  const normalized = value.trim().toLowerCase();
  await withWorkspace(db, workspaceId, async (tx) => {
    await addToSuppressionList(tx, [{ value: normalized, reason }]);
    await (reason === "asked" ? stopEveryoneAt(tx, normalized) : stopExcludedAt(tx, normalized));
  });
}

/** Who the workspace never writes to again, the latest first. Its own list only: what bounced for another workspace may be an address from that workspace's own file. */
export async function suppressedOf(db: Database, workspaceId: string) {
  return withWorkspace(db, workspaceId, (tx) => tx.select({ value: suppression.value, reason: suppression.reason, createdAt: suppression.createdAt }).from(suppression).where(ownSuppression).orderBy(desc(suppression.createdAt)));
}
