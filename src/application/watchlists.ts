import { desc, eq } from "drizzle-orm";
import { prospectable, type RegistryCompany } from "@/domain/registry";
import { searchBodacc } from "@/infrastructure/bodacc/client";
import { watchlist, type WatchQuery } from "@/infrastructure/db/schema/sequences";
import { withWorkspace } from "@/infrastructure/db/tenant";
import type { Database } from "@/infrastructure/db/client";
import { scheduledWorkChanged } from "@/infrastructure/scheduling/scheduled-work";
import { connectionsWith } from "./connections";
import { lookUpCompanies } from "./directory";
import { addFromRegistry } from "./prospects";
import type { Services } from "./services";

export type { WatchQuery };

/**
 * A search that runs by itself on public data: what BODACC announced lately, narrowed by what the
 * registry says of each company, goes on a list, and the workspace hears about it. The rules of a
 * list still apply: a company that refused commercial use of its data is never added.
 */

const DAY_MS = 86_400_000;
const FIRST_LOOK_DAYS = 7;
/** BODACC doesn't say what a company does, so each one is looked up, at the pace the registry allows: a minute's worth a run. */
const MAX_LOOKUPS = 300;
const MAX_PAGES = 14;

export async function createWatchlist(db: Database, workspaceId: string, userId: string, input: { name: string; query: WatchQuery; listId: string }): Promise<string> {
  const [row] = await withWorkspace(db, workspaceId, (tx) => tx.insert(watchlist).values({ name: input.name.trim(), query: input.query, listId: input.listId, createdBy: userId }).returning({ id: watchlist.id }));
  scheduledWorkChanged();
  return row.id;
}

export async function watchlistsOf(db: Database, workspaceId: string) {
  return withWorkspace(db, workspaceId, (tx) => tx.select().from(watchlist).orderBy(desc(watchlist.createdAt)));
}

export async function deleteWatchlist(db: Database, workspaceId: string, id: string): Promise<boolean> {
  const deleted = await withWorkspace(db, workspaceId, (tx) => tx.delete(watchlist).where(eq(watchlist.id, id)).returning({ id: watchlist.id }));
  scheduledWorkChanged();
  return deleted.length > 0;
}

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

async function announced(services: Services, query: WatchQuery, from: Date, to: Date): Promise<{ sirens: string[]; total: number }> {
  const sirens = new Set<string>();
  const search = { families: query.families, onlyDirectorChanges: query.onlyDirectorChanges, department: query.department, words: query.words };
  let total = 0;
  for (let page = 1; page <= MAX_PAGES && sirens.size < MAX_LOOKUPS; page++) {
    const found = await searchBodacc({ ...search, publishedFrom: isoDay(from), publishedTo: isoDay(to), page }, services.fetch);
    total = found.total;
    for (const announcement of found.announcements) for (const siren of announcement.sirens) sirens.add(siren);
    if (page >= found.pages) break;
  }
  return { sirens: [...sirens].slice(0, MAX_LOOKUPS), total };
}

/** A run that couldn't read everything says so, rather than look complete: what it skipped won't come back. */
const tooMany = (read: number, total: number) => (total > read ? `Trop d’annonces\u00a0: ${read} lues sur ${total}, les plus récentes. Précisez le département ou les mots de cette veille.` : null);

const matches = (found: RegistryCompany, query: WatchQuery) => prospectable(found) && (!query.activities?.length || query.activities.includes(found.activity ?? "")) && (!query.legalForms?.length || query.legalForms.includes(found.legalForm ?? ""));

async function announce(services: Services, workspaceId: string, name: string, added: number, listId: string) {
  const url = new URL(`/lists/${listId}`, services.settings.BETTER_AUTH_URL).toString();
  for (const alert of await connectionsWith(services, workspaceId, "notify")) {
    await alert.client.notify?.({ event: "watchlist", title: `${name} : ${added} ${added > 1 ? "nouvelles personnes" : "nouvelle personne"}`, text: "Sur la liste, prêtes à être ajoutées à une séquence.", url }).catch(() => undefined);
  }
}

/** Runs one watchlist from where it last stopped. A public service being down is a note, not a failure: the next run covers the gap. */
export async function runWatchlist(services: Services, workspaceId: string, id: string): Promise<{ ok: true; added: number } | { ok: false; error: string }> {
  const [row] = await withWorkspace(services.db, workspaceId, (tx) => tx.select().from(watchlist).where(eq(watchlist.id, id)));
  if (!row) return { ok: false, error: "Cette veille n’existe pas." };
  const now = services.now();
  const from = row.checkedUntil ?? new Date(now.getTime() - FIRST_LOOK_DAYS * DAY_MS);
  try {
    const { sirens, total } = await announced(services, row.query, from, now);
    const companies = [...(await lookUpCompanies(services, workspaceId, sirens)).values()].filter((found) => matches(found, row.query));
    const { added } = await addFromRegistry(services.db, workspaceId, row.listId, companies);
    await withWorkspace(services.db, workspaceId, (tx) => tx.update(watchlist).set({ checkedUntil: now, lastAdded: added, lastError: tooMany(sirens.length, total) }).where(eq(watchlist.id, id)));
    if (added > 0) await announce(services, workspaceId, row.name, added, row.listId);
    return { ok: true, added };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Le service n’a pas répondu.";
    await withWorkspace(services.db, workspaceId, (tx) => tx.update(watchlist).set({ lastError: message }).where(eq(watchlist.id, id)));
    return { ok: false, error: message };
  }
}

/** Every watchlist of every workspace, on the trusted path: the daily run. */
export async function runAllWatchlists(services: Services): Promise<{ checked: number; added: number }> {
  const rows = await services.db.select({ id: watchlist.id, workspaceId: watchlist.workspaceId }).from(watchlist);
  let added = 0;
  for (const row of rows) {
    const result = await runWatchlist(services, row.workspaceId, row.id);
    if (result.ok) added += result.added;
  }
  return { checked: rows.length, added };
}
