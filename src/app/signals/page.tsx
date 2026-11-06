import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { signalsOf } from "@/application/signals";
import type { SignalType } from "@/application/ports";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { EmptyState, Eyebrow, Rows } from "@/components/ui";
import { Radio } from "lucide-react";

export const metadata: Metadata = { title: "Retours" };

const TYPE_NAMES: Record<SignalType, string> = {
  replied: "A répondu",
  auto_reply: "Réponse automatique",
  bounced: "Adresse refusée",
  opted_out: "Ne veut plus de messages",
  delivered: "Remis",
  failed: "Échec",
  answered: "A décroché",
  no_answer: "Pas de réponse",
  voicemail_left: "Message vocal laissé",
  meeting_booked: "Rendez-vous pris",
  meeting_cancelled: "Rendez-vous annulé",
  signed_up: "S’est inscrit",
};

const when = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" });

async function Signals() {
  const seat = await currentSeat();
  const signals = await signalsOf(db(), seat.workspaceId, { limit: 200 });
  if (signals.length === 0) return <EmptyState icon={Radio} title="Rien pour le moment">Les réponses, les rendez-vous et les inscriptions arriveront ici.</EmptyState>;
  return (
    <Rows>
      {signals.map((signal, index) => (
        <li key={index} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-5 py-3 text-sm">
          <span className="font-medium">{TYPE_NAMES[signal.type]}</span>
          <span className="min-w-0 truncate text-muted-foreground">{signal.address ?? "Adresse inconnue"}</span>
          <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
            {signal.channel} · {when.format(signal.at)}
          </span>
          {signal.detail && <p className="w-full text-muted-foreground">{signal.detail}</p>}
        </li>
      ))}
    </Rows>
  );
}

/** What came back from every channel, the latest first. */
export default function SignalsPage() {
  return (
    <Shell>
      <PageHeading title="Retours" eyebrow={<Eyebrow><Link href="/replies" className="hover:text-foreground">Réponses</Link></Eyebrow>}>Ce que vos prospects ont fait, sur tous les canaux. Une réponse, un refus ou un STOP arrête la séquence ; un STOP ou une adresse refusée va sur la liste d’exclusion.</PageHeading>
      <Suspense fallback={<Loading />}>
        <Signals />
      </Suspense>
    </Shell>
  );
}
