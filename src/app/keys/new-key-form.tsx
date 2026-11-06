"use client";

import { useActionState } from "react";
import { Code, INLINE_FIELD, PrimaryButton } from "@/components/ui";
import { createKeyAction } from "./actions";

/** Names a key and shows it, this once. */
export function NewKeyForm() {
  const [state, submit, pending] = useActionState(createKeyAction, {});
  return (
    <form action={submit} className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-3">
        <input name="name" required maxLength={80} placeholder="Tableau de bord" aria-label="Nom de la clé" className={`${INLINE_FIELD} min-w-0 flex-1 basis-56`} />
        <PrimaryButton type="submit" disabled={pending}>
          Créer une clé
        </PrimaryButton>
      </div>
      {state.key && (
        <div>
          <p className="mb-2 text-sm text-muted-foreground">Copiez-la maintenant : elle ne s’affichera plus.</p>
          <Code>{state.key}</Code>
        </div>
      )}
    </form>
  );
}
