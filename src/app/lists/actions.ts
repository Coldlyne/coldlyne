"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Tried } from "@/application/connection-use";
import { pushToCrm } from "@/application/contacts";
import { importProspects, importSheet, type Imported } from "@/application/imports";
import { createList } from "@/application/prospects";
import { readProspectsCsv } from "@/domain/csv-import";
import { currentSeat } from "@/infrastructure/auth/session";
import { appServices } from "@/infrastructure/services";

export async function createListAction(formData: FormData): Promise<void> {
  const seat = await currentSeat();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const listId = await createList(appServices().db, seat.workspaceId, name);
  redirect(`/lists/${listId}`);
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
  return pushed.ok ? { ok: true, said: `Envoyé à ${pushed.through}.` } : pushed;
}
