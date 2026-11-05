"use client";

import { useActionState } from "react";
import { Code, PrimaryButton } from "@/components/ui";
import { createKeyAction } from "./actions";

/** Names a key and shows it, this once. */
export function NewKeyForm() {
  const [state, submit, pending] = useActionState(createKeyAction, {});
  return (
    <form action={submit} className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-3">
        <input name="name" required maxLength={80} placeholder="Tableau de bord" className="min-w-0 flex-1 rounded-lg border bg-surface px-3 py-2 text-sm outline-none focus:border-ring" />
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
