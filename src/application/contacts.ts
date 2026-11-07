import { and, eq, inArray, sql } from "drizzle-orm";
import { onePerDetail, type ContactFinding } from "@/domain/contacts";
import { sha256 } from "@/infrastructure/crypto/secrets";
import type { Database } from "@/infrastructure/db/client";
import { crmPush } from "@/infrastructure/db/schema/connections";
import { company, contactDetail, person, prospect } from "@/infrastructure/db/schema/prospects";
import { withWorkspace } from "@/infrastructure/db/tenant";
import type { Channel, ContactPusher, CrmContact } from "./ports";
import { openConnection } from "./connections";
import { ownDetailsFirst } from "./directory";
import type { Services } from "./services";

/** Keeps a detail a member confirmed, with the page it was found on, for every workspace of the directory. False when the prospect isn't in this workspace. */
export async function confirmContact(db: Database, workspaceId: string, prospectId: string, finding: ContactFinding): Promise<boolean> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [found] = await tx.select({ personId: prospect.personId }).from(prospect).where(eq(prospect.id, prospectId));
    if (!found) return false;
    await tx.insert(contactDetail).values({ personId: found.personId, kind: finding.kind, value: finding.value, page: finding.page, source: "website" }).onConflictDoNothing();
    return true;
  });
}

/** How to reach each of these people, with where it came from: what the directory found, and what this workspace brought itself. */
export async function contactsOf(db: Database, workspaceId: string, personIds: readonly string[]) {
  if (personIds.length === 0) return [];
  return onePerDetail(await withWorkspace(db, workspaceId, (tx) => tx.select({ personId: contactDetail.personId, kind: contactDetail.kind, value: contactDetail.value, page: contactDetail.page, source: contactDetail.source }).from(contactDetail).where(inArray(contactDetail.personId, [...personIds])).orderBy(...ownDetailsFirst)));
}

/** What a CRM needs to know about a prospect, from what the workspace holds. */
async function crmContactOf(db: Database, workspaceId: string, prospectId: string, note: string, channel?: Channel): Promise<CrmContact | null> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [row] = await tx
      .select({ personId: person.id, firstName: person.firstName, lastName: person.lastName, role: person.role, company: company.name, siren: company.siren, website: company.website })
      .from(prospect)
      .innerJoin(person, eq(person.id, prospect.personId))
      .innerJoin(company, eq(company.id, person.companyId))
      .where(eq(prospect.id, prospectId));
    if (!row) return null;
    const details = await tx.select({ kind: contactDetail.kind, value: contactDetail.value }).from(contactDetail).where(and(eq(contactDetail.personId, row.personId), inArray(contactDetail.kind, ["email", "phone"]))).orderBy(...ownDetailsFirst);
    const valueOf = (kind: string) => details.find((detail) => detail.kind === kind)?.value ?? null;
    return { firstName: row.firstName, lastName: row.lastName, email: valueOf("email"), phone: valueOf("phone"), role: row.role, company: { name: row.company, siren: row.siren, website: row.website }, note, channel };
  });
}

export type Pushed = { ok: true; externalId: string; through: string; already: boolean } | { ok: false; error: string };

/**
 * Sends a prospect to a connected CRM: created or updated there, with the note added. The same
 * note again changes nothing, so an assistant's retry can't repeat it on the CRM's timeline; with
 * no note, a push only brings the person up to date, as often as it's asked. It writes to the CRM
 * and nowhere else: nobody is contacted.
 */
export async function pushToCrm(services: Services, workspaceId: string, connectionId: string, prospectId: string, note: string, channel?: Channel): Promise<Pushed> {
  const opened = await openConnection(services, workspaceId, connectionId);
  const pusher: Partial<ContactPusher> | undefined = opened?.client;
  if (!opened || !pusher?.pushContact) return { ok: false, error: "Cette connexion n’est pas un CRM." };
  const contact = await crmContactOf(services.db, workspaceId, prospectId, note, channel);
  if (!contact) return { ok: false, error: "Ce prospect n’est pas dans cet espace." };
  const noteHash = note ? sha256(note) : "";
  const through = opened.row.label;
  const earlier = note ? await pushOf(services.db, workspaceId, connectionId, prospectId, noteHash) : undefined;
  if (earlier) return { ok: true, externalId: earlier.externalId, through, already: true };
  try {
    const { externalId } = await pusher.pushContact(contact);
    await rememberPush(services, workspaceId, { connectionId, prospectId, noteHash, externalId });
    return { ok: true, externalId, through, already: false };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Le CRM n’a pas répondu." };
  }
}

async function pushOf(db: Database, workspaceId: string, connectionId: string, prospectId: string, noteHash: string) {
  const [row] = await withWorkspace(db, workspaceId, (tx) => tx.select({ externalId: crmPush.externalId }).from(crmPush).where(and(eq(crmPush.connectionId, connectionId), eq(crmPush.prospectId, prospectId), eq(crmPush.noteHash, noteHash))));
  return row;
}

async function rememberPush(services: Services, workspaceId: string, push: { connectionId: string; prospectId: string; noteHash: string; externalId: string }) {
  const pushedAt = services.now();
  await withWorkspace(services.db, workspaceId, (tx) =>
    tx
      .insert(crmPush)
      .values({ ...push, pushedAt })
      .onConflictDoUpdate({ target: [crmPush.connectionId, crmPush.prospectId, crmPush.noteHash], set: { externalId: push.externalId, pushedAt } }),
  );
}

/** When each of these prospects last went to each CRM, for the list to show. */
export async function pushesOf(db: Database, workspaceId: string, prospectIds: readonly string[]): Promise<{ prospectId: string; connectionId: string; pushedAt: Date }[]> {
  if (prospectIds.length === 0) return [];
  return withWorkspace(db, workspaceId, (tx) =>
    tx
      .select({ prospectId: crmPush.prospectId, connectionId: crmPush.connectionId, pushedAt: sql<Date>`max(${crmPush.pushedAt})`.mapWith(crmPush.pushedAt) })
      .from(crmPush)
      .where(inArray(crmPush.prospectId, [...prospectIds]))
      .groupBy(crmPush.prospectId, crmPush.connectionId),
  );
}
