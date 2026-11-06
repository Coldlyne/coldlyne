import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { listsOf } from "@/application/prospects";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { Card, EmptyState, INLINE_FIELD, PrimaryButton, Rows, Tag } from "@/components/ui";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { createListAction } from "./actions";
import { ListChecks } from "lucide-react";

export const metadata: Metadata = { title: "Listes" };

async function Lists() {
  const seat = await currentSeat();
  const lists = await listsOf(db(), seat.workspaceId);
  return (
    <div className="space-y-4">
      <Card>
        <form action={createListAction} className="flex flex-wrap gap-3">
          <input name="name" required maxLength={120} placeholder="Holdings du Rhône" aria-label="Nom de la liste" className={`${INLINE_FIELD} min-w-0 flex-1 basis-56`} />
          <PrimaryButton type="submit">Créer une liste</PrimaryButton>
        </form>
      </Card>
      {lists.length === 0 ? (
        <EmptyState icon={ListChecks} title="Aucune liste pour le moment">
          Demandez à votre assistant de trouver les personnes à joindre, ou créez une liste ici et importez votre fichier.
        </EmptyState>
      ) : (
        <Rows>
          {lists.map((list) => (
            <li key={list.id}>
              <Link href={`/lists/${list.id}`} className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm transition-colors hover:bg-accent">
                <span className="min-w-0 truncate font-medium">{list.name}</span>
                <Tag>
                  {list.prospects} {list.prospects > 1 ? "prospects" : "prospect"}
                </Tag>
              </Link>
            </li>
          ))}
        </Rows>
      )}
    </div>
  );
}

/** The lists a workspace's campaigns work through. */
export default function ListsPage() {
  return (
    <Shell>
      <PageHeading title="Listes">Les personnes à joindre. Demandez à votre assistant de les trouver, ou importez votre propre fichier.</PageHeading>
      <Suspense fallback={<Loading />}>
        <Lists />
      </Suspense>
    </Shell>
  );
}
