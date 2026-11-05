import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { workspacesOf, type MemberWorkspace } from "@/application/workspaces";
import { Logo } from "@/components/logo";
import { Loading } from "@/components/shell";
import { Card } from "@/components/ui";
import { listInFrench } from "@/domain/words";
import { auth } from "@/infrastructure/auth/server";
import { currentMember } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { ConsentButtons } from "./consent-buttons";

export const metadata: Metadata = { title: "Autoriser un assistant" };

/** An assistant acts inside a workspace: a new member names theirs first, then comes back here. */
async function requireWorkspaces(query: Record<string, string | string[] | undefined>): Promise<MemberWorkspace[]> {
  const member = await currentMember();
  if (!member) redirect("/sign-in");
  const workspaces = await workspacesOf(db(), member.userId);
  if (workspaces.length > 0) return workspaces;
  const here = new URLSearchParams(Object.entries(query).flatMap(([key, value]) => (typeof value === "string" ? [[key, value]] : [])));
  redirect(`/welcome?${new URLSearchParams({ next: `/consent?${here}` })}`);
}

/** The assistant asking, by the name it registered with; a name it can't prove, so it is shown with its address. */
async function Request({ searchParams }: { searchParams: PageProps<"/consent">["searchParams"] }) {
  const query = await searchParams;
  const workspaces = await requireWorkspaces(query);
  const { client_id: clientId } = query;
  const client = typeof clientId === "string" ? await auth().api.getOAuthClientPublic({ query: { client_id: clientId }, headers: await headers() }).catch(() => null) : null;
  return (
    <Card className="mt-8 w-full max-w-md">
      <h1 className="text-xl font-semibold tracking-[-0.03em]">{client?.client_name ?? "Un assistant"} demande à accéder à Coldlyne</h1>
      {client?.client_uri && <p className="mt-1 font-mono text-xs text-muted-foreground">{client.client_uri}</p>}
      <p className="mt-4 text-sm text-muted-foreground">
        Il pourra agir en votre nom {workspaces.length > 1 ? `dans tous vos espaces, ${listInFrench(workspaces.map(({ name }) => name))}` : "dans votre espace"} : chercher des entreprises, préparer et envoyer vos campagnes dans les limites de l’espace, lire les réponses. Les plafonds, la liste d’exclusion et les mentions légales s’appliquent toujours à lui.
      </p>
      <p className="mt-3 text-sm text-muted-foreground">Vous pourrez lui retirer cet accès à tout moment.</p>
      <div className="mt-6">
        <ConsentButtons />
      </div>
    </Card>
  );
}

/** Where a member approves or refuses an assistant. */
export default function ConsentPage({ searchParams }: PageProps<"/consent">) {
  return (
    <main className="relative isolate flex flex-1 flex-col items-center justify-center px-4 py-16">
      <div aria-hidden className="absolute inset-x-0 top-0 -z-10 h-96 bg-glow" />
      <Logo id="consent" />
      <Suspense fallback={<Loading />}>
        <Request searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
