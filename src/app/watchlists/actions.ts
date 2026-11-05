"use server";

import { revalidatePath } from "next/cache";
import type { Tried } from "@/application/connection-use";
import { createList } from "@/application/prospects";
import { createWatchlist, deleteWatchlist, runWatchlist } from "@/application/watchlists";
import { BODACC_FAMILIES, type BodaccFamily } from "@/domain/bodacc";
import { currentSeat } from "@/infrastructure/auth/session";
import { appServices } from "@/infrastructure/services";

const words = (value: FormDataEntryValue | null) =>
  String(value ?? "")
    .split(/[\s,]+/)
    .filter(Boolean);

export async function createWatchlistAction(_previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const services = appServices();
  const name = String(form.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Donnez un nom à cette veille." };
  const families = form.getAll("families").map(String).filter((family) => BODACC_FAMILIES.includes(family as BodaccFamily)) as BodaccFamily[];
  const listId = String(form.get("listId") ?? "") || (await createList(services.db, seat.workspaceId, name));
  const query = { families, department: String(form.get("department") ?? "").trim() || undefined, words: String(form.get("words") ?? "").trim() || undefined, activities: words(form.get("activities")), legalForms: words(form.get("legalForms")), onlyDirectorChanges: form.get("onlyDirectorChanges") === "on" };
  await createWatchlist(services.db, seat.workspaceId, seat.userId, { name, listId, query });
  revalidatePath("/watchlists");
  return { ok: true, said: "Veille créée : elle tourne chaque matin." };
}

export async function runWatchlistAction(id: string): Promise<Tried> {
  const seat = await currentSeat();
  const result = await runWatchlist(appServices(), seat.workspaceId, id);
  revalidatePath("/watchlists");
  return result.ok ? { ok: true, said: `${result.added} ${result.added > 1 ? "personnes ajoutées" : "personne ajoutée"}.` } : result;
}

export async function deleteWatchlistAction(id: string): Promise<void> {
  const seat = await currentSeat();
  await deleteWatchlist(appServices().db, seat.workspaceId, id);
  revalidatePath("/watchlists");
}
