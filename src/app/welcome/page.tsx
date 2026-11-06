import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { groupsOwnedBy } from "@/application/groups";
import { mayStartWorkspace, startWorkspace, workspacesOf } from "@/application/workspaces";
import { AuthCard, AuthFrame, AuthTitle } from "@/components/auth-frame";
import { Loading } from "@/components/shell";
import { SignOutButton } from "@/components/sign-out-button";
import { FIELD, Labelled, PrimaryButton } from "@/components/ui";
import { safeNext } from "@/domain/safe-next";
import { currentMember, enterWorkspace } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { env } from "@/infrastructure/env";

export const metadata: Metadata = { title: "Bienvenue" };

async function create(formData: FormData) {
  "use server";
  const member = await currentMember();
  if (!member) redirect("/sign-in");
  const created = await startWorkspace(db(), env(), member, String(formData.get("name") ?? ""), String(formData.get("group") ?? "") || undefined);
  if (created) await enterWorkspace(created);
  redirect(safeNext(formData.get("next")));
}

/** Someone with an account and no workspace who may not start one: an invitation that was cancelled, or a workspace they were taken out of. */
function NoWorkspace() {
  return (
    <AuthCard>
      <AuthTitle>Vous n’avez accès à aucun espace</AuthTitle>
      <p className="mt-2 text-sm text-muted-foreground">Sur Coldlyne, on rejoint un espace sur invitation&nbsp;: demandez un nouveau lien à la personne qui l’administre, puis ouvrez-le.</p>
      <div className="mt-5 text-sm text-muted-foreground">
        <SignOutButton />
      </div>
    </AuthCard>
  );
}

/** Sent on when the member may not start a workspace and has one; asks those who may to name a new one, their first or another. */
async function Form({ searchParams }: { searchParams: PageProps<"/welcome">["searchParams"] }) {
  const { next } = await searchParams;
  const member = await currentMember();
  if (!member) redirect("/sign-in");
  const hasWorkspace = (await workspacesOf(db(), member.userId)).length > 0;
  if (!mayStartWorkspace(member.email, env())) {
    if (hasWorkspace) redirect(safeNext(next));
    return <NoWorkspace />;
  }
  const groups = await groupsOwnedBy(db(), member.userId);
  return (
    <AuthCard>
      <AuthTitle>Quelle entreprise prospecte ?</AuthTitle>
      <p className="mt-2 text-sm text-muted-foreground">Chaque espace garde ses listes, ses boîtes et ses exclusions à part. Les entreprises et les personnes trouvées servent aux espaces du même groupe.</p>
      <form action={create} className="mt-5 flex flex-col gap-3">
        <input type="hidden" name="next" value={safeNext(next)} />
        <input name="name" required maxLength={80} placeholder="Acme" aria-label="Nom de l’entreprise" className={FIELD} />
        {groups.length > 0 && (
          <Labelled label="Groupe" hint="Un espace ne change plus de groupe ensuite.">
            <select name="group" defaultValue="" className={FIELD}>
              <option value="">Un nouveau groupe</option>
              {groups.map(({ id, name }) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </Labelled>
        )}
        <PrimaryButton type="submit">Créer l’espace</PrimaryButton>
      </form>
      {hasWorkspace && (
        <p className="mt-4 text-center text-sm">
          <Link href={safeNext(next)} className="text-muted-foreground hover:text-foreground">
            Annuler
          </Link>
        </p>
      )}
    </AuthCard>
  );
}

/** The first thing a new member sees, and where an admin starts another: a workspace, named. */
export default function WelcomePage({ searchParams }: PageProps<"/welcome">) {
  return (
    <AuthFrame id="welcome">
      <Suspense fallback={<Loading />}>
        <Form searchParams={searchParams} />
      </Suspense>
    </AuthFrame>
  );
}
