import { and, eq, inArray, sql } from "drizzle-orm";
import { readProspectsSheet, spreadsheetIdOf, type CsvImport, type ImportedProspect, type RejectedRow } from "@/domain/csv-import";
import type { ElsewhereNote } from "@/domain/directory";
import { prospectable } from "@/domain/registry";
import type { Database } from "@/infrastructure/db/client";
import { company, contactDetail, person, prospect, suppression } from "@/infrastructure/db/schema/prospects";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { openConnection } from "./connections";
import { companyNamed, elsewhereAmong, lookUpCompanies } from "./directory";
import { ownSuppression } from "./enrollments";
import type { Services } from "./services";

export interface Imported {
  added: number;
  /** Rows left out: unreadable ones, and those the rules keep out, with why. */
  rejected: RejectedRow[];
  /** Those just added that another workspace of the directory wrote to, or who opted out of it: nothing stops them, a member decides. */
  elsewhere?: ElsewhereNote[];
}

/** The most companies a single import looks up in the registry: its API is shared and limits its callers. */
export const MAX_IMPORT_LOOKUPS = 200;

/**
 * Puts a member's file on a list. The file is theirs, but the rules still hold: a company that
 * refused commercial use of its data, or someone on the suppression list, stays out. The registry
 * is asked first, so a refused lookup leaves nothing half imported.
 */
export async function importProspects(services: Services, workspaceId: string, listId: string, file: CsvImport): Promise<Imported> {
  const refused = await companiesThatRefused(services, workspaceId, file.rows);
  return withWorkspace(services.db, workspaceId, async (tx) => {
    const suppressed = await suppressedAmong(tx, file.rows);
    const result: Imported = { added: 0, rejected: [...file.rejected] };
    const addedPeople: string[] = [];
    for (const row of file.rows) {
      const why = whyLeftOut(row, refused, suppressed);
      if (why) result.rejected.push({ line: row.line, why });
      else {
        const personId = await addRow(tx, listId, row);
        if (personId) addedPeople.push(personId);
      }
    }
    result.added = addedPeople.length;
    result.rejected.sort((a, b) => a.line - b.line);
    const elsewhere = await elsewhereAmong(tx, addedPeople);
    return elsewhere.length ? { ...result, elsewhere } : result;
  });
}

/** The SIRENs in the file whose company refused commercial use or closed. A row without a SIREN can't be checked, and is said so where it's used. */
async function companiesThatRefused(services: Services, workspaceId: string, rows: readonly ImportedProspect[]): Promise<Set<string>> {
  const sirens = [...new Set(rows.flatMap((row) => (row.siren ? [row.siren] : [])))];
  if (sirens.length > MAX_IMPORT_LOOKUPS) throw new Error(`Ce fichier compte ${sirens.length} entreprises : importez-le par tranches de ${MAX_IMPORT_LOOKUPS} au plus.`);
  const found = await lookUpCompanies(services, workspaceId, sirens);
  return new Set(sirens.filter((siren) => found.has(siren) && !prospectable(found.get(siren)!)));
}

const domainOf = (email: string) => email.slice(email.indexOf("@") + 1);

async function suppressedAmong(tx: Database, rows: readonly ImportedProspect[]): Promise<Set<string>> {
  const values = [...new Set(rows.flatMap((row) => [row.email, row.email && domainOf(row.email), row.phone].filter((value): value is string => Boolean(value))))];
  if (values.length === 0) return new Set();
  const found = await tx.select({ value: suppression.value }).from(suppression).where(and(inArray(suppression.value, values), ownSuppression));
  return new Set(found.map((row) => row.value));
}

function whyLeftOut(row: ImportedProspect, refused: ReadonlySet<string>, suppressed: ReadonlySet<string>): string | null {
  if (row.siren && refused.has(row.siren)) return "l’entreprise est fermée ou a refusé l’usage commercial de ses données";
  if ([row.email, row.email && domainOf(row.email), row.phone].some((value) => value && suppressed.has(value))) return "cette personne est sur la liste d’exclusion";
  if (!row.lastName) return "il manque le nom de la personne";
  if (!row.company && !row.siren) return "il manque l’entreprise";
  return null;
}

/** One person on the list, with their company and contact details: who, or null when they already were on it. Their details stay this workspace's: they have no page to say where they're published. */
async function addRow(tx: Database, listId: string, row: ImportedProspect): Promise<string | null> {
  const companyId = await companyOf(tx, row);
  const personId = await personOf(tx, companyId, row);
  const details = [
    { kind: "email", value: row.email },
    { kind: "phone", value: row.phone },
    { kind: "linkedin", value: row.linkedin },
  ].flatMap(({ kind, value }) => (value ? [{ personId, kind, value, source: "import" as const }] : []));
  if (details.length) await tx.insert(contactDetail).values(details).onConflictDoNothing();
  const added = await tx.insert(prospect).values({ listId, personId }).onConflictDoNothing().returning({ id: prospect.id });
  return added.length ? personId : null;
}

/** The company by its SIREN, else by its exact name among those without one; made when unknown. */
async function companyOf(tx: Database, row: ImportedProspect): Promise<string> {
  const name = row.company ?? (row.siren as string);
  const known = row.siren ? (await tx.select({ id: company.id }).from(company).where(eq(company.siren, row.siren)))[0]?.id : await companyNamed(tx, name);
  if (known) return known;
  const [created] = await tx.insert(company).values({ siren: row.siren, name, website: row.website, source: "import" }).returning({ id: company.id });
  return created.id;
}

async function personOf(tx: Database, companyId: string, row: ImportedProspect): Promise<string> {
  const lastName = row.lastName as string;
  const match = and(eq(person.companyId, companyId), row.firstName === null ? sql`${person.firstName} is null` : eq(person.firstName, row.firstName), eq(person.lastName, lastName));
  const [known] = await tx.select({ id: person.id }).from(person).where(match);
  if (known) return known.id;
  const [created] = await tx.insert(person).values({ companyId, firstName: row.firstName, lastName, role: row.role, source: "import" }).returning({ id: person.id });
  return created.id;
}

/** The same from a sheet read through a connected Google Sheets account: its first tab, or a range. */
export async function importSheet(services: Services, workspaceId: string, connectionId: string, listId: string, spreadsheet: string, range?: string): Promise<{ ok: true; imported: Imported } | { ok: false; error: string }> {
  const opened = await openConnection(services, workspaceId, connectionId);
  if (!opened?.client.rows) return { ok: false, error: "Cette connexion ne lit pas de feuille de calcul." };
  try {
    return { ok: true, imported: await importProspects(services, workspaceId, listId, readProspectsSheet(await opened.client.rows(spreadsheetIdOf(spreadsheet), range))) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Google n’a pas répondu." };
  }
}
