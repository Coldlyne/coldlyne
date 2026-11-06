"use client";

import { useActionState } from "react";
import { INLINE_FIELD, QuietButton } from "@/components/ui";
import { factsAction, type FactsState } from "../actions";

/** What sources call what they know, in the member's words; anything else keeps its own name. */
const FACT_NAMES: Record<string, string> = {
  active: "En activité",
  registryOptOut: "Refuse la prospection",
  legalForm: "Forme juridique",
  activity: "Activité",
  createdOn: "Créée le",
  registeredOn: "Immatriculée le",
  headcountBand: "Tranche d’effectif",
  headcountYear: "Année de l’effectif",
  category: "Catégorie",
  headOffice: "Siège",
  establishmentsTotal: "Établissements",
  directors: "Dirigeants",
  filings: "Actes déposés",
};

const shown = (value: unknown) => (typeof value === "boolean" ? (value ? "Oui" : "Non") : typeof value === "object" ? JSON.stringify(value) : String(value));

/** Asks a connected source about one company: what it holds, in its own words where they have no name here. */
export function CompanyLookup({ connectionId }: { connectionId: string }) {
  const [state, submit, pending] = useActionState<FactsState, FormData>(factsAction.bind(null, connectionId), null);
  return (
    <form action={submit} className="mt-4 flex flex-wrap items-center gap-2 text-sm">
      <input name="siren" required inputMode="numeric" placeholder="SIREN : 123 456 789" aria-label="SIREN" className={`${INLINE_FIELD} min-w-0 flex-1 sm:max-w-56`} />
      <QuietButton type="submit" disabled={pending}>
        {pending ? "Recherche…" : "Chercher une entreprise"}
      </QuietButton>
      {state && !state.ok && <p className="w-full text-ember">{state.error}</p>}
      {state?.ok && (
        <div className="w-full">
          <p className="font-medium">{state.facts.name}</p>
          <dl className="mt-2 grid max-h-72 gap-x-4 gap-y-1 overflow-auto rounded-lg border bg-surface p-3 text-xs sm:grid-cols-[auto_1fr]">
            {Object.entries(state.facts.facts)
              .filter(([, value]) => value !== null && !(Array.isArray(value) && value.length === 0))
              .map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-muted-foreground">{FACT_NAMES[key] ?? key}</dt>
                  <dd className="min-w-0 font-mono break-words">{shown(value)}</dd>
                </div>
              ))}
          </dl>
        </div>
      )}
    </form>
  );
}
