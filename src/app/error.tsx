"use client";

import { AuthFrame } from "@/components/auth-frame";
import { PrimaryButton } from "@/components/ui";

/** Something failed while reading the page: a way to try again, and the reference to quote if it lasts. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <AuthFrame id="error" horizon={false}>
      <h1 className="mt-10 pb-1 text-center text-4xl font-medium tracking-[-0.045em] text-display md:text-5xl">Cette page n’a pas pu s’afficher</h1>
      <p className="mt-3 max-w-sm text-center text-sm text-muted-foreground">Réessayez dans un instant. Rien de ce que vous aviez enregistré n’est perdu.</p>
      <PrimaryButton onClick={reset} className="mt-7">
        Réessayer
      </PrimaryButton>
      {error.digest && <p className="mt-6 font-mono text-[11px] text-muted-foreground">Référence {error.digest}</p>}
    </AuthFrame>
  );
}
