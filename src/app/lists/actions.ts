"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Tried } from "@/application/connection-use";
import { pushToCrm } from "@/application/contacts";
import { findCompanies, type CompaniesFound } from "@/application/directory";
import { importProspects, importSheet, type Imported } from "@/application/imports";
import { addCompanies, createList } from "@/application/prospects";
import { readProspectsCsv } from "@/domain/csv-import";
import { elsewhereWithName } from "@/domain/directory";
import { currentSeat } from "@/infrastructure/auth/session";
import { appServices } from "@/infrastructure/services";

export async function createListAction(formData: FormData): Promise<void> {
  const seat = await currentSeat();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const listId = await createList(appServices().db, seat.workspaceId, name);
  redirect(`/lists/${listId}`);
}

export type SearchState = { found?: CompaniesFound; words?: string; error?: string };

/** What the group holds under these words, or what the registry finds when it holds nothing or the member asks. */
export async function findCompaniesAction(_previous: SearchState, formData: FormData): Promise<SearchState> {
  const seat = await currentSeat();
  const words = String(formData.get("words") ?? "").trim();
  if (words.length < 2) return { error: "Indiquez un nom ou un SIREN." };
  try {
    return { found: await findCompanies(appServices(), seat.workspaceId, words, formData.get("registry") === "1"), words };
  } catch (error) {
    return { words, error: error instanceof Error ? error.message : "La recherche a échoué." };
  }
}

/** Puts a company's directors on the list, saying who another workspace of the group already wrote to: the member decides what to do about it. */
export async function addCompanyAction(listId: string, siren: string): Promise<Tried> {
  const seat = await currentSeat();
  const { added, elsewhere } = await addCompanies(appServices(), seat.workspaceId, listId, [siren]);
  revalidatePath(`/lists/${listId}`);
  const said = added ? `${added} ${added > 1 ? "personnes ajoutées" : "personne ajoutée"}.` : "Personne de nouveau à ajouter.";
  return { ok: true, said: [said, ...(elsewhere ?? []).map(elsewhereWithName)].join(" ") };
}

export type ImportState = { result?: Imported; error?: string };

/** Puts a member's file on the list: what the rules keep out comes back with its line and why. */
export async function importCsvAction(listId: string, _previous: ImportState, formData: FormData): Promise<ImportState> {
  const seat = await currentSeat();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choisissez un fichier CSV." };
  try {
    const result = await importProspects(appServices(), seat.workspaceId, listId, readProspectsCsv(await file.text()));
    revalidatePath(`/lists/${listId}`);
    return { result };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "L’import a échoué." };
  }
}

/** The same from a sheet, read through a connected Google Sheets account. */
export async function importSheetAction(listId: string, connectionId: string, _previous: ImportState, formData: FormData): Promise<ImportState> {
  const seat = await currentSeat();
  const spreadsheet = String(formData.get("spreadsheet") ?? "").trim();
  if (!spreadsheet) return { error: "Collez l’adresse de la feuille." };
  const range = String(formData.get("range") ?? "").trim() || undefined;
  const imported = await importSheet(appServices(), seat.workspaceId, connectionId, listId, spreadsheet, range);
  if (!imported.ok) return { error: imported.error };
  revalidatePath(`/lists/${listId}`);
  return { result: imported.imported };
}

/** Sends a prospect to a connected CRM, without a note: the member adds what they want there. */
export async function pushToCrmAction(listId: string, connectionId: string, prospectId: string): Promise<Tried> {
  const seat = await currentSeat();
  const pushed = await pushToCrm(appServices(), seat.workspaceId, connectionId, prospectId, "");
  revalidatePath(`/lists/${listId}`);
  if (!pushed.ok) return pushed;
  return { ok: true, said: pushed.externalId ? `Envoyé à ${pushed.through}.` : `Cette personne a été supprimée de ${pushed.through} : elle y reste supprimée, rien n’y a été écrit.` };
}
