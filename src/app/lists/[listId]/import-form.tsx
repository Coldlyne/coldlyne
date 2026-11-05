"use client";

import { useActionState } from "react";
import { PrimaryButton } from "@/components/ui";
import { importCsvAction, importSheetAction, type ImportState } from "../actions";

/** What came of an import: what was added, and each row left out with why. */
function ImportReport({ state }: { state: ImportState }) {
  return (
    <>
      {state.error && <p className="text-sm text-ember">{state.error}</p>}
      {state.result && (
        <div className="text-sm">
          <p>
            {state.result.added} {state.result.added > 1 ? "personnes ajoutées" : "personne ajoutée"}.
          </p>
          {state.result.rejected.length > 0 && (
            <ul className="mt-2 space-y-1 text-muted-foreground">
              {state.result.rejected.map((row) => (
                <li key={`${row.line}-${row.why}`}>
                  Ligne {row.line} : {row.why}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

/** A member's file, read on the server: what was added, and each row left out with why. */
export function ImportForm({ listId }: { listId: string }) {
  const [state, submit, pending] = useActionState<ImportState, FormData>(importCsvAction.bind(null, listId), {});
  return (
    <form action={submit} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <input type="file" name="file" accept=".csv,text/csv" required className="min-w-0 flex-1 text-sm text-muted-foreground" />
        <PrimaryButton type="submit" disabled={pending}>
          {pending ? "Import en cours…" : "Importer"}
        </PrimaryButton>
      </div>
      <p className="text-xs text-muted-foreground">Colonnes reconnues, en français ou en anglais : prénom, nom, email, téléphone, société, siren, site, fonction, linkedin.</p>
      <ImportReport state={state} />
    </form>
  );
}

/** The same from a sheet, through a Google account the workspace connected. */
export function SheetImportForm({ listId, connectionId, label }: { listId: string; connectionId: string; label: string }) {
  const [state, submit, pending] = useActionState<ImportState, FormData>(importSheetAction.bind(null, listId, connectionId), {});
  return (
    <form action={submit} className="flex flex-col gap-3">
      <p className="text-sm font-medium">Importer une feuille de {label}</p>
      <div className="flex flex-wrap items-center gap-3">
        <input name="spreadsheet" required placeholder="L’adresse de la feuille" aria-label="L’adresse de la feuille" className="min-w-0 flex-[2] rounded-lg border bg-surface px-3 py-2 text-sm outline-none focus:border-ring" />
        <input name="range" placeholder="Plage (facultatif)" aria-label="Plage (facultatif)" className="min-w-0 flex-1 rounded-lg border bg-surface px-3 py-2 text-sm outline-none focus:border-ring" />
        <PrimaryButton type="submit" disabled={pending}>
          {pending ? "Import en cours…" : "Importer"}
        </PrimaryButton>
      </div>
      <ImportReport state={state} />
    </form>
  );
}
