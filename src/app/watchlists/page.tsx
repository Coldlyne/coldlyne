import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { listsOf } from "@/application/prospects";
import { watchlistsOf } from "@/application/watchlists";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { ActionForm, ConfirmButton, TryButton } from "@/components/try-button";
import { Card, FIELD, Labelled } from "@/components/ui";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { createWatchlistAction, deleteWatchlistAction, runWatchlistAction } from "./actions";

export const metadata: Metadata = { title: "Veilles" };

const when = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" });

const FAMILIES = [
  ["creation", "Créations"],
  ["immatriculation", "Immatriculations"],
  ["modification", "Modifications"],
  ["vente", "Ventes et cessions"],
] as const;

async function Content() {
  const seat = await currentSeat();
  const [watchlists, lists] = await Promise.all([watchlistsOf(db(), seat.workspaceId), listsOf(db(), seat.workspaceId)]);
  return (
    <div className="space-y-4">
      {watchlists.length > 0 && (
        <ul className="space-y-3">
          {watchlists.map((watch) => (
            <li key={watch.id}>
              <Card>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="min-w-0 flex-1 font-medium">{watch.name}</span>
                  <TryButton action={runWatchlistAction.bind(null, watch.id)} label="Lancer maintenant" busy="Recherche…" />
                  <ConfirmButton action={deleteWatchlistAction.bind(null, watch.id)} label="Arrêter" confirm="Confirmer" />
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {watch.checkedUntil ? `Dernier passage le ${when.format(watch.checkedUntil)}, ${watch.lastAdded} ajout${watch.lastAdded > 1 ? "s" : ""}` : "Pas encore lancée"} ·{" "}
                  <Link href={`/lists/${watch.listId}`} className="hover:underline">
                    voir la liste
                  </Link>
                </p>
                {watch.lastError && <p className="mt-2 text-sm text-ember">{watch.lastError}</p>}
              </Card>
            </li>
          ))}
        </ul>
      )}
      <Card>
        <h2 className="font-semibold tracking-[-0.02em]">Nouvelle veille</h2>
        <div className="mt-4">
          <ActionForm action={createWatchlistAction} submit="Créer la veille" busy="…" className="flex flex-col gap-4">
            <Labelled label="Nom">
              <input name="name" required maxLength={120} placeholder="Holdings créées dans le Rhône" className={FIELD} />
            </Labelled>
            <fieldset className="text-sm">
              <legend>Annonces à suivre</legend>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
                {FAMILIES.map(([value, label]) => (
                  <label key={value} className="flex items-center gap-2">
                    <input type="checkbox" name="families" value={value} defaultChecked={value === "creation"} />
                    {label}
                  </label>
                ))}
                <label className="flex items-center gap-2">
                  <input type="checkbox" name="onlyDirectorChanges" />
                  Seulement les changements de dirigeant
                </label>
              </div>
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-2">
              <Labelled label="Département">
                <input name="department" placeholder="69" className={FIELD} />
              </Labelled>
              <Labelled label="Mots dans l’annonce">
                <input name="words" className={FIELD} />
              </Labelled>
              <Labelled label="Codes d’activité (NAF)" hint="64.20Z pour les holdings.">
                <input name="activities" placeholder="64.20Z" className={FIELD} />
              </Labelled>
              <Labelled label="Formes juridiques" hint="5710 pour une SAS, 5720 pour une SASU.">
                <input name="legalForms" placeholder="5710, 5720" className={FIELD} />
              </Labelled>
            </div>
            <Labelled label="Liste où les ajouter">
              <select name="listId" defaultValue="" className={FIELD}>
                <option value="">Une nouvelle liste à son nom</option>
                {lists.map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.name}
                  </option>
                ))}
              </select>
            </Labelled>
          </ActionForm>
        </div>
      </Card>
    </div>
  );
}

/** Searches that run by themselves on public announcements, free: new companies and new directors, as they appear. */
export default function WatchlistsPage() {
  return (
    <Shell>
      <PageHeading title="Veilles">Chaque matin, Coldlyne lit les annonces officielles du BODACC&nbsp;: ce qui correspond arrive sur votre liste, et vous êtes prévenu sur vos alertes. Une entreprise qui refuse la prospection n’est jamais ajoutée.</PageHeading>
      <Suspense fallback={<Loading />}>
        <Content />
      </Suspense>
    </Shell>
  );
}
