import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { mayStartWorkspace, startWorkspace, workspacesOf } from "@/application/workspaces";
import { Logo } from "@/components/logo";
import { Loading } from "@/components/shell";
import { SignOutButton } from "@/components/sign-out-button";
import { Card, PrimaryButton } from "@/components/ui";
import { safeNext } from "@/domain/safe-next";
import { currentMember, enterWorkspace } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { env } from "@/infrastructure/env";

export const metadata: Metadata = { title: "Bienvenue" };

async function create(formData: FormData) {
  "use server";
  const member = await currentMember();
  if (!member) redirect("/sign-in");
  const created = await startWorkspace(db(), env(), member, String(formData.get("name") ?? ""));
  if (created) await enterWorkspace(created);
  redirect(safeNext(formData.get("next")));
}

/** Someone with an account and no workspace who may not start one: an invitation that was cancelled, or a workspace they were taken out of. */
function NoWorkspace() {
  return (
    <Card className="mt-8 w-full max-w-md">
      <h1 className="text-xl font-semibold tracking-[-0.03em]">Vous n’avez accès à aucun espace</h1>
      <p className="mt-2 text-sm text-muted-foreground">Sur Coldlyne, on rejoint un espace sur invitation&nbsp;: demandez un nouveau lien à la personne qui l’administre, puis ouvrez-le.</p>
      <div className="mt-5 text-sm text-muted-foreground">
        <SignOutButton />
      </div>
    </Card>
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
  return (
    <Card className="mt-8 w-full max-w-md">
      <h1 className="text-xl font-semibold tracking-[-0.03em]">Quelle entreprise prospecte ?</h1>
      <p className="mt-2 text-sm text-muted-foreground">Chaque espace garde ses listes, ses boîtes et ses exclusions à part.</p>
      <form action={create} className="mt-5 flex flex-col gap-3">
        <input type="hidden" name="next" value={safeNext(next)} />
        <input name="name" required maxLength={80} placeholder="Acme" className="rounded-lg border bg-surface px-3 py-2 text-sm outline-none focus:border-ring" />
        <PrimaryButton type="submit">Créer l’espace</PrimaryButton>
      </form>
      {hasWorkspace && (
        <p className="mt-4 text-center text-sm">
          <Link href={safeNext(next)} className="text-muted-foreground hover:text-foreground">
            Annuler
          </Link>
        </p>
      )}
    </Card>
  );
}

/** The first thing a new member sees, and where an admin starts another: a workspace, named. */
export default function WelcomePage({ searchParams }: PageProps<"/welcome">) {
  return (
    <main className="relative isolate flex flex-1 flex-col items-center justify-center px-4 py-16">
      <div aria-hidden className="absolute inset-x-0 top-0 -z-10 h-96 bg-glow" />
      <Logo id="welcome" />
      <Suspense fallback={<Loading />}>
        <Form searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
