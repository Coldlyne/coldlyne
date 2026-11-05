"use client";

import { useState } from "react";
import { PrimaryButton } from "@/components/ui";
import { authClient } from "@/infrastructure/auth/client";

/** Signs in with this instance's provider; an assistant's pending request continues by itself afterwards. */
export function SignInButton({ provider, name }: { provider: string; name: string }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function signIn() {
    setBusy(true);
    const { error: refused } = await authClient.signIn.social({ provider, callbackURL: "/", errorCallbackURL: "/sign-in" });
    if (refused) {
      setError(refused.message ?? "La connexion a échoué.");
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col items-center gap-3">
      <PrimaryButton onClick={signIn} disabled={busy}>
        Continuer avec {name}
      </PrimaryButton>
      {error && <p className="max-w-sm text-center text-sm text-ember">{error}</p>}
    </div>
  );
}
