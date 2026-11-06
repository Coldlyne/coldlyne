import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { workspacesOf, type MemberWorkspace } from "@/application/workspaces";
import { AuthCard, AuthFrame, AuthTitle } from "@/components/auth-frame";
import { Loading } from "@/components/shell";
import { whereAccessGoes } from "@/domain/consent";
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

/** The assistant asking, by the name it registered with. Anyone can register under any name and address, so what the screen vouches for is where the code goes. */
async function Request({ searchParams }: { searchParams: PageProps<"/consent">["searchParams"] }) {
  const query = await searchParams;
  const workspaces = await requireWorkspaces(query);
  const { client_id: clientId, redirect_uri: redirectUri } = query;
  const target = whereAccessGoes(redirectUri);
  const client = typeof clientId === "string" ? await auth().api.getOAuthClientPublic({ query: { client_id: clientId }, headers: await headers() }).catch(() => null) : null;
  return (
    <AuthCard>
      <AuthTitle>{client?.client_name ?? "Un assistant"} demande à accéder à Coldlyne</AuthTitle>
      <p className="mt-2 text-sm text-muted-foreground">
        {client?.client_name && "Il a choisi ce nom lui-même, et personne ne l’a vérifié. "}
        {target ? (
          <>
            Votre accès partirait vers <span className="font-mono font-medium text-foreground">{target}</span> : si vous ne reconnaissez pas cette adresse, refusez.
          </>
        ) : (
          "Impossible de savoir où partirait votre accès : refusez, à moins de savoir pourquoi vous êtes ici."
        )}
      </p>
      <p className="mt-4 text-sm text-muted-foreground">
        Il pourra agir en votre nom {workspaces.length > 1 ? `dans tous vos espaces, ${listInFrench(workspaces.map(({ name }) => name))}` : "dans votre espace"} : chercher des entreprises, préparer et envoyer vos campagnes dans les limites de l’espace, lire les réponses et, pour un propriétaire ou un administrateur, créer et révoquer des clés d’API qui lisent les chiffres de l’espace. Les plafonds, la liste d’exclusion et les mentions légales s’appliquent toujours à lui.
      </p>
      <p className="mt-3 text-sm text-muted-foreground">Vous pourrez lui retirer cet accès à tout moment.</p>
      <div className="mt-6">
        <ConsentButtons />
      </div>
    </AuthCard>
  );
}

/** Where a member approves or refuses an assistant. */
export default function ConsentPage({ searchParams }: PageProps<"/consent">) {
  return (
    <AuthFrame id="consent">
      <Suspense fallback={<Loading />}>
        <Request searchParams={searchParams} />
      </Suspense>
    </AuthFrame>
  );
}
