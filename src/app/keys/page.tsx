import type { Metadata } from "next";
import { Suspense } from "react";
import { apiKeysOf } from "@/application/api-keys";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { Card, Code, QuietButton } from "@/components/ui";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { env } from "@/infrastructure/env";
import { revokeKeyAction } from "./actions";
import { NewKeyForm } from "./new-key-form";

export const metadata: Metadata = { title: "Clés d’API" };

const day = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeZone: "Europe/Paris" });

async function Keys() {
  const seat = await currentSeat();
  const keys = await apiKeysOf(db(), seat.workspaceId);
  return (
    <div className="space-y-4">
      <Card>
        <NewKeyForm />
        <p className="mt-5 text-sm text-muted-foreground">Les chiffres de l’espace, sans aucun nom ni adresse :</p>
        <div className="mt-2">
          <Code>GET {new URL("/api/v1/figures?days=30", env().BETTER_AUTH_URL).toString()}</Code>
        </div>
      </Card>
      {keys.length > 0 && (
        <ul className="divide-y rounded-2xl border bg-card">
          {keys.map((key) => (
            <li key={key.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 text-sm">
              <span className="font-medium">{key.name}</span>
              <span className="font-mono text-xs text-muted-foreground">{key.prefix}…</span>
              <span className="ml-auto text-xs text-muted-foreground">{key.lastUsedAt ? `Utilisée le ${day.format(key.lastUsedAt)}` : "Jamais utilisée"}</span>
              <form action={revokeKeyAction.bind(null, key.id)}>
                <QuietButton type="submit">Révoquer</QuietButton>
              </form>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Keys other apps (a dashboard) read the workspace's figures with. */
export default function KeysPage() {
  return (
    <Shell>
      <PageHeading title="Clés d’API">Pour qu’une autre application lise vos chiffres, sans jamais voir vos prospects.</PageHeading>
      <Suspense fallback={<Loading />}>
        <Keys />
      </Suspense>
    </Shell>
  );
}
