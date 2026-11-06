import type { ReactNode } from "react";
import { Horizon } from "./horizon";
import { Logo } from "./logo";

/** The pages outside the app: the mark, under a beam of light, over a lit horizon. An unsubscribe page goes without the horizon: it's someone leaving. */
export function AuthFrame({ id, horizon = true, children }: { id: string; horizon?: boolean; children: ReactNode }) {
  return (
    <main className="relative isolate flex flex-1 flex-col items-center justify-center overflow-hidden px-4 pt-16 pb-28">
      <div aria-hidden className="absolute inset-x-0 top-0 -z-20 h-[48rem] bg-spotlight" />
      <Logo id={id} />
      {children}
      {horizon && <Horizon className="top-[calc(100%-5rem)]" />}
    </main>
  );
}

/** What the page asks, on a pane of glass. */
export function AuthCard({ children }: { children: ReactNode }) {
  return (
    <div className="glass-frame mt-8 w-full max-w-md">
      <div className="rounded-[1.1rem] border bg-card p-6">{children}</div>
    </div>
  );
}

export function AuthTitle({ children }: { children: ReactNode }) {
  return <h1 className="pb-0.5 text-xl font-medium tracking-[-0.03em] text-pretty">{children}</h1>;
}
