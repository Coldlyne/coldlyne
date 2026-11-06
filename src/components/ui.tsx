import type { LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

const BUTTON = "inline-flex min-h-9 items-center justify-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50";

/** The look of the page's main action: monochrome, the colour is left to the line and the light. */
export const PRIMARY_BUTTON = `${BUTTON} bg-primary text-primary-foreground shadow-[0_8px_30px_-12px_color-mix(in_oklab,var(--ice)_60%,transparent)] hover:opacity-90`;

/** The look of every other action, a link's included. */
export const QUIET_BUTTON = `${BUTTON} border text-foreground hover:bg-accent`;

export function PrimaryButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={`${PRIMARY_BUTTON} ${className}`} />;
}

export function QuietButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={`${QUIET_BUTTON} ${className}`} />;
}

/** A raised surface, with a hairline that catches the light at the top. */
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`card-premium rounded-2xl p-5 sm:p-6 ${className}`}>{children}</div>;
}

export function CardTitle({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <h2 className={`font-medium tracking-[-0.02em] ${className}`}>{children}</h2>;
}

/** Rows on one surface, separated by hairlines: lists of records, whichever they are. */
export function Rows({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <ul className={`card-premium divide-y overflow-hidden rounded-2xl ${className}`}>{children}</ul>;
}

/** The mono label above a title or a group: led by a point of light, as on the website. */
export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p className={`flex min-w-0 items-center gap-2.5 font-mono text-[11px] tracking-[0.18em] text-muted-foreground uppercase ${className}`}>
      <span aria-hidden className="size-1 shrink-0 rounded-full bg-ice shadow-[0_0_8px_var(--ice)]" />
      <span className="min-w-0 truncate">{children}</span>
    </p>
  );
}

/** A short state beside a record. Ember is kept for what comes back and what needs a person. */
export function Tag({ children, warm = false }: { children: ReactNode; warm?: boolean }) {
  return <span className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 font-mono text-[10.5px] whitespace-nowrap ${warm ? "border-ember/30 bg-ember/[0.08] text-ember" : "text-muted-foreground"}`}>{children}</span>;
}

/** Nothing here yet: what would be here, and what to do about it. */
export function EmptyState({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed px-6 py-12 text-center">
      <span className="grid size-10 place-items-center rounded-xl border bg-card text-ice">
        <Icon aria-hidden className="size-[18px]" />
      </span>
      <p className="mt-4 font-medium tracking-[-0.015em]">{title}</p>
      {children && <p className="mt-1.5 max-w-md text-sm text-pretty text-muted-foreground">{children}</p>}
    </div>
  );
}

/** Whether something works, at a glance: frost when it does, ember when it needs a look. */
export function StatusDot({ status }: { status: "connected" | "failing" }) {
  const fine = status === "connected";
  return (
    <span className={`inline-block size-2 shrink-0 rounded-full ${fine ? "bg-ice shadow-[0_0_8px_var(--ice)]" : "bg-ember shadow-[0_0_10px_var(--ember)]"}`}>
      <span className="sr-only">{fine ? "En ordre" : "À vérifier"}</span>
    </span>
  );
}

/** A value to copy: an address, a key, a command. */
export function Code({ children }: { children: ReactNode }) {
  return <code className="block rounded-lg border bg-surface px-3 py-2 font-mono text-xs break-all">{children}</code>;
}

/** The look of a field beside others in a row, as wide as what it holds. 16px on a phone: iOS zooms the page into anything smaller. */
export const INLINE_FIELD = "rounded-lg border border-input bg-surface px-3 py-2 text-base outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 sm:text-sm";

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
