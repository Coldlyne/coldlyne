import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { Logo } from "@/components/logo";
import { signInOf } from "@/infrastructure/auth/sign-in";
import { env } from "@/infrastructure/env";
import { ResetForm } from "./reset-form";

export const metadata: Metadata = { title: "Nouveau mot de passe" };

async function Reset({ searchParams }: Pick<PageProps<"/reset-password">, "searchParams">) {
  await connection();
  if (!signInOf(env()).passwords) notFound();
  const { token } = await searchParams;
  if (typeof token === "string") return <ResetForm token={token} />;
  return (
    <p className="mt-8 max-w-sm text-center text-sm text-muted-foreground">
      Ce lien a expiré ou a déjà servi.{" "}
      <Link href="/sign-in" className="text-foreground underline underline-offset-4">
        Demandez-en un nouveau
      </Link>
    </p>
  );
}

/** Where the link of a forgotten password leads. */
export default function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  return (
    <main className="relative isolate flex flex-1 flex-col items-center justify-center px-4 py-16">
      <div aria-hidden className="absolute inset-x-0 top-0 -z-10 h-96 bg-glow" />
      <Logo id="reset-password" />
      <h1 className="mt-8 text-center text-3xl font-semibold tracking-[-0.04em]">Un nouveau mot de passe</h1>
      <Suspense>
        <Reset searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
