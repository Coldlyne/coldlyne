import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { conversationsOf } from "@/application/threads";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { INTEREST_NAMES, INTERESTS, type Interest } from "@/domain/sequences";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";

export const metadata: Metadata = { title: "Réponses" };

const when = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" });

async function Conversations({ searchParams }: Pick<PageProps<"/replies">, "searchParams">) {
  const { interest } = await searchParams;
  const seat = await currentSeat();
  const filter = INTERESTS.includes(interest as Interest) ? (interest as Interest) : undefined;
  const conversations = await conversationsOf(db(), seat.workspaceId, filter);
  return (
    <div className="space-y-4">
      <nav className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <Link href="/replies" className={filter ? "hover:text-foreground" : "text-foreground"}>
          Toutes
        </Link>
        {INTERESTS.map((value) => (
          <Link key={value} href={`/replies?interest=${value}`} className={filter === value ? "text-foreground" : "hover:text-foreground"}>
            {INTEREST_NAMES[value]}
          </Link>
        ))}
        <Link href="/signals" className="ml-auto hover:text-foreground">
          Tout ce qui est revenu
        </Link>
      </nav>
      {conversations.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aucune réponse pour le moment.</p>
      ) : (
        <ul className="divide-y rounded-2xl border bg-card">
          {conversations.map((conversation) => (
            <li key={conversation.prospectId}>
              <Link href={`/replies/${conversation.prospectId}`} className="block px-5 py-3 text-sm transition-colors hover:bg-accent">
                <span className="flex flex-wrap items-baseline gap-x-3">
                  <span className="font-medium">{conversation.person}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{conversation.company}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{conversation.interest ? INTEREST_NAMES[conversation.interest] : "À lire"}</span>
                  {conversation.lastAt && <span className="font-mono text-[11px] text-muted-foreground">{when.format(conversation.lastAt)}</span>}
                </span>
                {conversation.lastDetail && <span className="mt-1 line-clamp-2 block text-muted-foreground">{conversation.lastDetail}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Everyone who answered, whichever channel it came through. */
export default function RepliesPage({ searchParams }: PageProps<"/replies">) {
  return (
    <Shell>
      <PageHeading title="Réponses">Une conversation par personne, tous canaux confondus. Une réponse arrête sa séquence, et celles de son entreprise.</PageHeading>
      <Suspense fallback={<Loading />}>
        <Conversations searchParams={searchParams} />
      </Suspense>
    </Shell>
  );
}
