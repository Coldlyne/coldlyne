"use client";

import { useActionState } from "react";
import { INLINE_FIELD, PrimaryButton } from "@/components/ui";
import type { Field } from "@/domain/connectors";
import { connectAction, type ConnectState } from "../actions";

/** What the provider's console gives, typed here and checked against the provider before it is saved. */
export function ConnectForm({ kind, fields }: { kind: string; fields: readonly Field[] }) {
  const [state, submit, pending] = useActionState<ConnectState, FormData>(connectAction.bind(null, kind), {});
  return (
    <form action={submit} className="flex flex-col gap-4">
      {fields.map((field) => (
        <label key={field.key} className="flex flex-col gap-1.5 text-sm">
          <span>
            {field.label}
            {field.optional && <span className="text-muted-foreground"> (facultatif)</span>}
          </span>
          <input name={field.key} type={field.secret ? "password" : "text"} autoComplete="off" required={!field.optional} placeholder={field.placeholder} className={`${INLINE_FIELD} font-mono sm:text-xs`} />
          {field.help && <span className="text-xs text-muted-foreground">{field.help}</span>}
        </label>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <PrimaryButton type="submit" disabled={pending}>
          {pending ? "Vérification…" : "Vérifier et connecter"}
        </PrimaryButton>
        {state.connected && <span className="text-sm text-ice">Connecté : {state.connected}</span>}
      </div>
      {state.error && <p className="text-sm text-ember">{state.error}</p>}
    </form>
  );
}
