"use client";

import { useActionState } from "react";
import type { KnownCompany } from "@/application/directory";
import { TryButton } from "@/components/try-button";
import { INLINE_FIELD, PrimaryButton, QuietButton, Tag } from "@/components/ui";
import { elsewhereInWords } from "@/domain/directory";
import { addCompanyAction, findCompaniesAction, type SearchState } from "../actions";

const fullName = ({ firstName, lastName }: { firstName: string | null; lastName: string }) => [firstName, lastName].filter(Boolean).join(" ");

/** One company found: who's there, how to reach them, what another workspace did with them, and a way to add them. */
function Found({ listId, found }: { listId: string; found: KnownCompany }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-border py-3 text-sm">
      <span className="font-medium">{found.name}</span>
      <span className="text-muted-foreground">{[found.siren, found.city].filter(Boolean).join(" · ")}</span>
      {found.held && <Tag>Déjà dans ce groupe</Tag>}
      <div className="ml-auto flex flex-wrap items-center gap-2">{found.mayBeProspected && found.siren ? <TryButton action={addCompanyAction.bind(null, listId, found.siren)} label="Ajouter à la liste" busy="Ajout…" /> : !found.mayBeProspected && <Tag>Refuse l’usage commercial de ses données</Tag>}</div>
      {found.people.map((known) => (
        <div key={`${known.id}-${fullName(known)}`} className="w-full text-xs text-muted-foreground">
          <p>
            {fullName(known)}
            {known.role ? `, ${known.role}` : ""}
            {known.contacts.length > 0 && ` · ${known.contacts.map(({ value }) => value).join(" · ")}`}
          </p>
          {known.elsewhere.map((note) => (
            <p key={note.workspace} className="text-ember">
              {elsewhereInWords(note)}
            </p>
          ))}
        </div>
      ))}
    </li>
  );
}

/** Looks for a company: first in what the group holds, which asks nobody; then in the registry, when it holds nothing or the member asks. */
export function CompanySearch({ listId }: { listId: string }) {
  const [state, search, pending] = useActionState<SearchState, FormData>(findCompaniesAction, {});
  return (
    <div className="flex flex-col gap-3">
      <form action={search} className="flex flex-wrap items-center gap-3">
        <input name="words" required minLength={2} defaultValue={state.words} placeholder="Nom ou SIREN d’une entreprise" aria-label="Nom ou SIREN d’une entreprise" className={`${INLINE_FIELD} min-w-0 flex-1 basis-56`} />
        <PrimaryButton type="submit" disabled={pending}>
          {pending ? "Recherche…" : "Chercher"}
        </PrimaryButton>
        {state.found?.from === "directory" && (
          <QuietButton type="submit" name="registry" value="1" disabled={pending}>
            Chercher aussi au registre
          </QuietButton>
        )}
      </form>
      {state.error && <p className="text-sm text-ember">{state.error}</p>}
      {state.found?.companies.length === 0 && <p className="text-sm text-muted-foreground">Aucune entreprise trouvée.</p>}
      {state.found && state.found.companies.length > 0 && (
        <ul>
          {state.found.companies.map((found) => (
            <Found key={found.siren ?? found.name} listId={listId} found={found} />
          ))}
        </ul>
      )}
    </div>
  );
}
