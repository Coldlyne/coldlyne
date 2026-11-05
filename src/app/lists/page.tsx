import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { listsOf } from "@/application/prospects";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { Card, PrimaryButton } from "@/components/ui";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { createListAction } from "./actions";

export const metadata: Metadata = { title: "Listes" };

async function Lists() {
  const seat = await currentSeat();
  const lists = await listsOf(db(), seat.workspaceId);
  return (
    <div className="space-y-4">
      <Card>
        <form action={createListAction} className="flex flex-wrap gap-3">
          <input name="name" required maxLength={120} placeholder="Holdings du Rhône" className="min-w-0 flex-1 rounded-lg border bg-surface px-3 py-2 text-sm outline-none focus:border-ring" />
          <PrimaryButton type="submit">Créer une liste</PrimaryButton>
        </form>
      </Card>
      {lists.length > 0 && (
        <ul className="divide-y rounded-2xl border bg-card">
          {lists.map((list) => (
            <li key={list.id}>
              <Link href={`/lists/${list.id}`} className="flex items-baseline justify-between gap-4 px-5 py-3 text-sm transition-colors hover:bg-accent">
                <span className="min-w-0 truncate font-medium">{list.name}</span>
                <span className="shrink-0 text-muted-foreground">
                  {list.prospects} {list.prospects > 1 ? "prospects" : "prospect"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
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
