import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { sequencesOf } from "@/application/sequences";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { Card, FIELD, PrimaryButton } from "@/components/ui";
import { SEQUENCE_STATUS_NAMES } from "@/domain/sequences";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { createSequenceAction } from "./actions";

export const metadata: Metadata = { title: "Séquences" };

const plural = (count: number, one: string, many: string) => `${count} ${count > 1 ? many : one}`;

async function Sequences() {
  const seat = await currentSeat();
  const sequences = await sequencesOf(db(), seat.workspaceId);
  return (
    <div className="space-y-4">
      <Card>
        <form action={createSequenceAction} className="flex flex-wrap gap-3">
          <input name="name" required maxLength={120} placeholder="Holdings du Rhône, novembre" aria-label="Nom de la séquence" className={`${FIELD} min-w-0 flex-1`} />
          <PrimaryButton type="submit">Créer une séquence</PrimaryButton>
        </form>
      </Card>
      {sequences.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aucune séquence pour le moment. Créez-en une ici, ou demandez à votre assistant&nbsp;: il sait tout faire d’ici aussi.</p>
      ) : (
        <ul className="divide-y rounded-2xl border bg-card">
          {sequences.map((sequence) => (
            <li key={sequence.id}>
              <Link href={`/sequences/${sequence.id}`} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-5 py-3 text-sm transition-colors hover:bg-accent">
                <span className="min-w-0 flex-1 truncate font-medium">{sequence.name}</span>
                <span className="text-muted-foreground">
                  {plural(sequence.steps, "étape", "étapes")} · {plural(sequence.people, "personne", "personnes")} · {plural(sequence.sent, "envoi", "envois")} · {plural(sequence.replied, "réponse", "réponses")}
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">{SEQUENCE_STATUS_NAMES[sequence.status]}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Every campaign and where it stands. */
export default function SequencesPage() {
  return (
    <Shell>
      <PageHeading title="Séquences">Chaque campagne, étape par étape et canal par canal. Une réponse l’arrête pour la personne et son entreprise.</PageHeading>
      <Suspense fallback={<Loading />}>
        <Sequences />
      </Suspense>
    </Shell>
  );
}
