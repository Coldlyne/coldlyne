import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { createWorkspace, workspacesOf } from "@/application/workspaces";
import { Logo } from "@/components/logo";
import { Loading } from "@/components/shell";
import { Card, PrimaryButton } from "@/components/ui";
import { currentMember } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";

export const metadata: Metadata = { title: "Bienvenue" };

/** Where to go next: only a page of this app, so the address can't send a member elsewhere. */
const safeNext = (next: unknown) => (typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/");

async function create(formData: FormData) {
  "use server";
  const member = await currentMember();
  if (!member) redirect("/sign-in");
  const name = String(formData.get("name") ?? "").trim();
  if (name && (await workspacesOf(db(), member.userId)).length === 0) await createWorkspace(db(), member.userId, name);
  redirect(safeNext(formData.get("next")));
}

/** Sent on when the member already has a workspace, or asks them to name their first. */
async function Form({ searchParams }: { searchParams: PageProps<"/welcome">["searchParams"] }) {
  const { next } = await searchParams;
  const member = await currentMember();
  if (!member) redirect("/sign-in");
  if ((await workspacesOf(db(), member.userId)).length > 0) redirect(safeNext(next));
  return (
    <Card className="mt-8 w-full max-w-md">
      <h1 className="text-xl font-semibold tracking-[-0.03em]">Quelle entreprise prospecte ?</h1>
      <p className="mt-2 text-sm text-muted-foreground">Chaque espace garde ses listes, ses boîtes et ses exclusions à part.</p>
      <form action={create} className="mt-5 flex flex-col gap-3">
        <input type="hidden" name="next" value={safeNext(next)} />
        <input name="name" required maxLength={80} placeholder="Acme" className="rounded-lg border bg-surface px-3 py-2 text-sm outline-none focus:border-ring" />
        <PrimaryButton type="submit">Créer l’espace</PrimaryButton>
      </form>
    </Card>
  );
}

/** The first thing a new member sees: their workspace, named. */
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
