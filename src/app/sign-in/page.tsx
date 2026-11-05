import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { Logo } from "@/components/logo";
import { signInOf, type SignInMethods } from "@/infrastructure/auth/sign-in";
import { env } from "@/infrastructure/env";
import { PasswordForm } from "./password-form";
import { SignInButton } from "./sign-in-button";

export const metadata: Metadata = { title: "Connexion" };

/** What Better Auth reports when the account wasn't let in: anything else is the sign-in itself failing. */
const NOT_INVITED = "unable_to_create_user";

/** What the page says first, for the ways this instance has. */
function introOf({ provider, passwords }: SignInMethods) {
  if (provider) return `Connectez-vous avec votre compte ${provider.name} pour retrouver votre espace.`;
  return passwords ? "Connectez-vous pour retrouver votre espace." : "La connexion n’est pas encore ouverte sur cette instance.";
}

/** The instance's own ways in, read when the page is asked for: a build doesn't know the instance. */
async function SignIn({ searchParams }: Pick<PageProps<"/sign-in">, "searchParams">) {
  await connection();
  const ways = signInOf(env());
  const { error } = await searchParams;
  return (
    <>
      <p className="mt-3 max-w-sm text-center text-sm text-muted-foreground">{introOf(ways)}</p>
      {ways.provider && (
        <div className="mt-8">
          <SignInButton provider={ways.provider.id} name={ways.provider.name} />
        </div>
      )}
      {ways.provider && ways.passwords && <p className="mt-6 font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">ou</p>}
      {ways.passwords && <PasswordForm />}
      {error && <p className="mt-3 max-w-sm text-center text-sm text-ember">{error === NOT_INVITED ? "Ce compte n’a pas accès à Coldlyne pour le moment." : "La connexion a échoué\u00a0: réessayez dans un instant."}</p>}
    </>
  );
}

/** Where members sign in, and where an assistant sends them before they approve it. */
export default function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  return (
    <main className="relative isolate flex flex-1 flex-col items-center justify-center px-4 py-16">
      <div aria-hidden className="absolute inset-x-0 top-0 -z-10 h-96 bg-glow" />
      <Logo id="sign-in" />
      <h1 className="mt-8 text-center text-3xl font-semibold tracking-[-0.04em]">
        Votre prospection, <span className="font-serif font-normal italic tracking-normal text-frost">depuis votre assistant</span>
      </h1>
      <Suspense>
        <SignIn searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
