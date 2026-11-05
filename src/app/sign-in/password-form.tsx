"use client";

import { useState, type FormEvent } from "react";
import { FIELD, PrimaryButton } from "@/components/ui";
import { SIGN_UP_REFUSED } from "@/domain/sign-up";
import { authClient } from "@/infrastructure/auth/client";

type Mode = "sign-in" | "sign-up" | "forgot";

const SUBMIT: Record<Mode, string> = { "sign-in": "Se connecter", "sign-up": "Créer mon compte", forgot: "Recevoir un lien" };

/** Better Auth's codes, in the member's words; a message written for them (who may join) comes through as it is. */
const ERRORS: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "Adresse ou mot de passe incorrect.",
  EMAIL_NOT_VERIFIED: "Confirmez d’abord votre adresse : un nouveau lien vient de partir.",
  PASSWORD_TOO_SHORT: "Le mot de passe doit faire au moins 12 caractères.",
  INVALID_EMAIL: "Cette adresse n’est pas valide.",
};

function wordsFor(error: { code?: string; status?: number; message?: string }): string {
  if (error.status === 429) return "Trop de tentatives\u00a0: réessayez dans un instant.";
  const known = error.code ? ERRORS[error.code] : undefined;
  if (known) return known;
  return error.code === SIGN_UP_REFUSED && error.message ? error.message : "La connexion a échoué.";
}

/** Signs in, creates an account or asks for a new password, then on to `next`; an assistant's pending request continues by itself afterwards. */
export function PasswordForm({ next }: { next: string }) {
  const [mode, setMode] = useState<Mode>("sign-in");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  function show(next: Mode) {
    setMode(next);
    setError(null);
    setSent(null);
  }

  async function ask(email: string, password: string, name: string) {
    if (mode === "sign-in") return (await authClient.signIn.email({ email, password, callbackURL: next })).error;
    if (mode === "sign-up") return (await authClient.signUp.email({ email, password, name, callbackURL: next })).error;
    return (await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" })).error;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const [email, password, name] = ["email", "password", "name"].map((field) => String(form.get(field) ?? ""));
    setBusy(true);
    setError(null);
    const refused = await ask(email, password, name);
    setBusy(false);
    if (refused) return setError(wordsFor(refused));
    if (mode === "sign-up") setSent(`Un lien de confirmation vient de partir à ${email} : ouvrez-le pour activer votre compte.`);
    if (mode === "forgot") setSent(`Si ${email} a un compte, un lien vient d’y partir pour choisir un nouveau mot de passe.`);
  }

  if (sent) return <p className="mt-8 max-w-sm text-center text-sm text-muted-foreground">{sent}</p>;
  return (
    <form onSubmit={submit} className="mt-8 flex w-full max-w-sm flex-col gap-3">
      {mode === "sign-up" && <input name="name" required maxLength={80} autoComplete="name" placeholder="Votre nom" aria-label="Votre nom" className={FIELD} />}
      <input name="email" type="email" required autoComplete="email" placeholder="Adresse e-mail" aria-label="Adresse e-mail" className={FIELD} />
      {mode !== "forgot" && <input name="password" type="password" required minLength={12} autoComplete={mode === "sign-up" ? "new-password" : "current-password"} placeholder="Mot de passe" aria-label="Mot de passe" className={FIELD} />}
      <PrimaryButton type="submit" disabled={busy}>
        {SUBMIT[mode]}
      </PrimaryButton>
      {error && <p className="text-center text-sm text-ember">{error}</p>}
      <div className="mt-1 flex justify-center gap-4 text-sm text-muted-foreground">
        {mode !== "sign-in" && (
          <button type="button" onClick={() => show("sign-in")} className="hover:text-foreground">
            J’ai déjà un compte
          </button>
        )}
        {mode === "sign-in" && (
          <>
            <button type="button" onClick={() => show("sign-up")} className="hover:text-foreground">
              Créer un compte
            </button>
            <button type="button" onClick={() => show("forgot")} className="hover:text-foreground">
              Mot de passe oublié
            </button>
          </>
        )}
      </div>
    </form>
  );
}
