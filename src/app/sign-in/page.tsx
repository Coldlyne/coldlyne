import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { AuthFrame } from "@/components/auth-frame";
import { safeNext } from "@/domain/safe-next";
import { signInOf, type SignInMethods } from "@/infrastructure/auth/sign-in";
import { env } from "@/infrastructure/env";
import { PasswordForm } from "./password-form";
import { SignInButton } from "./sign-in-button";

export const metadata: Metadata = { title: "Connexion" };

/** What Better Auth reports when the account wasn't let in: anything else is the sign-in itself failing. */
const NOT_INVITED = "unable_to_create_user";

/** What the page says first, for the ways this instance has, and to someone who came from an invitation. */
function introOf({ provider, passwords }: SignInMethods, next: string) {
  if (next.startsWith("/join/") && (provider || passwords)) return "Connectez-vous avec l’adresse invitée, ou créez votre compte avec elle, pour rejoindre l’espace.";
  if (provider) return `Connectez-vous avec votre compte ${provider.name} pour retrouver votre espace.`;
  return passwords ? "Connectez-vous pour retrouver votre espace." : "La connexion n’est pas encore ouverte sur cette instance.";
}

/** The instance's own ways in, read when the page is asked for: a build doesn't know the instance. */
async function SignIn({ searchParams }: Pick<PageProps<"/sign-in">, "searchParams">) {
  await connection();
  const ways = signInOf(env());
  const { error, next: asked } = await searchParams;
  const next = safeNext(asked);
  return (
    <>
      <p className="mt-4 max-w-sm text-center text-sm text-pretty text-muted-foreground">{introOf(ways, next)}</p>
      {ways.provider && (
        <div className="mt-8">
          <SignInButton provider={ways.provider.id} name={ways.provider.name} next={next} />
        </div>
      )}
      {ways.provider && ways.passwords && <p className="mt-6 font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">ou</p>}
      {ways.passwords && <PasswordForm next={next} />}
      {error && <p className="mt-3 max-w-sm text-center text-sm text-ember">{error === NOT_INVITED ? "Ce compte n’a pas accès à Coldlyne pour le moment." : "La connexion a échoué\u00a0: réessayez dans un instant."}</p>}
    </>
  );
}

/** Where members sign in, and where an assistant sends them before they approve it. */
export default function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  return (
    <AuthFrame id="sign-in">
      <h1 className="mt-9 max-w-xl text-center text-4xl leading-[1.02] font-medium tracking-[-0.045em] text-balance md:text-5xl">
        <span className="text-display">Votre prospection,</span>
        <span className="block pr-1 pb-1 font-serif font-normal tracking-[-0.015em] text-frost italic">
          depuis votre assistant<span className="text-ember not-italic">.</span>
        </span>
      </h1>
      <Suspense>
        <SignIn searchParams={searchParams} />
      </Suspense>
    </AuthFrame>
  );
}
