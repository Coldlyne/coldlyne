import type { ButtonHTMLAttributes, ReactNode } from "react";

const BUTTON = "inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";

/** The page's main action: monochrome, the colour is left to the line and the light. */
export function PrimaryButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={`${BUTTON} bg-primary text-primary-foreground hover:opacity-90 ${className}`} />;
}

export function QuietButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={`${BUTTON} border text-foreground hover:bg-accent ${className}`} />;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`card-sheen rounded-2xl border bg-card p-6 ${className}`}>{children}</div>;
}

/** Whether a connection works, at a glance: frost when it does, ember when it needs a look. */
export function StatusDot({ status }: { status: "connected" | "failing" }) {
  return <span aria-hidden className={`inline-block size-2 shrink-0 rounded-full ${status === "connected" ? "bg-ice" : "bg-ember"}`} />;
}

/** A value to copy: an address, a key, a command. */
export function Code({ children }: { children: ReactNode }) {
  return <code className="block rounded-lg border bg-surface px-3 py-2 font-mono text-xs break-all">{children}</code>;
}

/** The look of a field beside others in a row, as wide as what it holds. */
export const INLINE_FIELD = "rounded-lg border bg-surface px-3 py-2 text-sm outline-none focus:border-ring";

/** The look of every text field and list in a form. */
export const FIELD = `w-full ${INLINE_FIELD}`;

/** A label over its field. */
export function Labelled({ label, hint, className = "", children }: { label: string; hint?: string; className?: string; children: ReactNode }) {
  return (
    <label className={`flex min-w-0 flex-col gap-1.5 text-sm ${className}`}>
      {label}
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}
