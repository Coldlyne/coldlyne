import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { conversationsOf } from "@/application/threads";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { INTEREST_NAMES, INTERESTS, type Interest } from "@/domain/sequences";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { EmptyState, Rows, Tag } from "@/components/ui";
import { Inbox } from "lucide-react";

export const metadata: Metadata = { title: "Réponses" };

const PILL = "rounded-full px-3 py-1 transition-colors hover:bg-accent hover:text-foreground";

const when = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" });

async function Conversations({ searchParams }: Pick<PageProps<"/replies">, "searchParams">) {
  const { interest } = await searchParams;
  const seat = await currentSeat();
  const filter = INTERESTS.includes(interest as Interest) ? (interest as Interest) : undefined;
  const conversations = await conversationsOf(db(), seat.workspaceId, filter);
  return (
    <div className="space-y-4">
      <nav aria-label="Filtrer les réponses" className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
        <Link href="/replies" aria-current={filter ? undefined : "page"} className={filter ? PILL : `${PILL} bg-accent text-foreground`}>
          Toutes
        </Link>
        {INTERESTS.map((value) => (
          <Link key={value} href={`/replies?interest=${value}`} aria-current={filter === value ? "page" : undefined} className={filter === value ? `${PILL} bg-accent text-foreground` : PILL}>
            {INTEREST_NAMES[value]}
          </Link>
        ))}
        <Link href="/signals" className="ml-auto px-3 py-1 text-link hover:underline">
          Tout ce qui est revenu
        </Link>
      </nav>
      {conversations.length === 0 ? (
        <EmptyState icon={Inbox} title="Aucune réponse pour le moment">
          Dès qu’une personne répond, sur n’importe quel canal, sa conversation arrive ici.
        </EmptyState>
      ) : (
        <Rows>
          {conversations.map((conversation) => (
            <li key={conversation.prospectId}>
              <Link href={`/replies/${conversation.prospectId}`} className="block px-5 py-3.5 text-sm transition-colors hover:bg-accent">
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-medium">{conversation.person}</span>
                  <span className="min-w-0 flex-1 basis-40 truncate text-muted-foreground">{conversation.company}</span>
                  <Tag warm={!conversation.interest}>{conversation.interest ? INTEREST_NAMES[conversation.interest] : "À lire"}</Tag>
                  {conversation.lastAt && <span className="font-mono text-[11px] text-muted-foreground">{when.format(conversation.lastAt)}</span>}
                </span>
                {conversation.lastDetail && <span className="mt-1 line-clamp-2 block text-muted-foreground">{conversation.lastDetail}</span>}
              </Link>
            </li>
          ))}
        </Rows>
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
