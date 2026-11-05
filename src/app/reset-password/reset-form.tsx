"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { FIELD, PrimaryButton } from "@/components/ui";
import { authClient } from "@/infrastructure/auth/client";

/** Chooses a new password with the link's token: every open session ends with the old one. */
export function ResetForm({ token }: { token: string }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: refused } = await authClient.resetPassword({ newPassword: String(new FormData(event.currentTarget).get("password")), token });
    setBusy(false);
    if (refused) return setError("Ce lien a expiré ou a déjà servi : demandez-en un nouveau.");
    setDone(true);
  }

  if (done) {
    return (
      <p className="mt-8 max-w-sm text-center text-sm text-muted-foreground">
        Votre mot de passe est changé.{" "}
        <Link href="/sign-in" className="text-foreground underline underline-offset-4">
          Connectez-vous
        </Link>
      </p>
    );
  }
  return (
    <form onSubmit={submit} className="mt-8 flex w-full max-w-sm flex-col gap-3">
      <input name="password" type="password" required minLength={12} autoComplete="new-password" placeholder="Nouveau mot de passe (12 caractères au moins)" aria-label="Nouveau mot de passe" className={FIELD} />
      <PrimaryButton type="submit" disabled={busy}>
        Changer mon mot de passe
      </PrimaryButton>
      {error && <p className="text-center text-sm text-ember">{error}</p>}
    </form>
  );
}
