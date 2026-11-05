"use client";

import { useActionState, useState, type ReactNode } from "react";
import type { Tried } from "@/application/connection-use";
import { PrimaryButton, QuietButton } from "./ui";

/** A button that tries something on the server and says, under the row, what came of it. */
export function TryButton({ action, label, busy }: { action: () => Promise<Tried>; label: string; busy: string }) {
  const [tried, run, pending] = useActionState<Tried | null, FormData>(() => action(), null);
  return (
    <form action={run} className="contents">
      <QuietButton type="submit" disabled={pending}>
        {pending ? busy : label}
      </QuietButton>
      {tried && (
        <p role="status" className={`order-last w-full text-sm ${tried.ok ? "text-ice" : "text-ember"}`}>
          {tried.ok ? tried.said : tried.error}
        </p>
      )}
    </form>
  );
}

/** A button for what can't be undone: the first press only asks. */
export function ConfirmButton({ action, label, confirm }: { action: () => Promise<unknown>; label: string; confirm: string }) {
  const [asked, setAsked] = useState(false);
  if (!asked) return <QuietButton onClick={() => setAsked(true)}>{label}</QuietButton>;
  return (
    <form action={() => void action()} className="contents">
      <QuietButton type="submit" className="border-ember text-ember">
        {confirm}
      </QuietButton>
      <QuietButton type="button" onClick={() => setAsked(false)}>
        Annuler
      </QuietButton>
    </form>
  );
}

/** A form that says what came of it under its fields. Its fields come from the server; only the answer lives here. */
export function ActionForm({ action, submit, busy, className = "flex flex-col gap-3", quiet = false, children }: { action: (previous: Tried | null, form: FormData) => Promise<Tried>; submit?: string; busy?: string; className?: string; quiet?: boolean; children: ReactNode }) {
  const [tried, run, pending] = useActionState<Tried | null, FormData>(action, null);
  const Button = quiet ? QuietButton : PrimaryButton;
  return (
    <form action={run} className={className}>
      {children}
      {submit && (
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? (busy ?? "…") : submit}
          </Button>
        </div>
      )}
      {tried && (
        <p role="status" className={`w-full text-sm whitespace-pre-line ${tried.ok ? "text-ice" : "text-ember"}`}>
          {tried.ok ? tried.said : tried.error}
        </p>
      )}
    </form>
  );
}

/** Copies a text the member will paste elsewhere: a LinkedIn message, a script. */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <QuietButton
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => setCopied(true));
      }}
    >
      {copied ? "Copié" : "Copier le texte"}
    </QuietButton>
  );
}
