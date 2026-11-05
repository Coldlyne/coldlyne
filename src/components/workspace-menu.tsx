"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { switchWorkspaceAction } from "./workspace-actions";

const ENTRY = "block w-full truncate rounded-lg px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent";

/** The workspace this is, and a menu of the member's others, plus starting a new one for those who may. */
export function WorkspaceMenu({ current, others, mayStart }: { current: string; others: { id: string; name: string }[]; mayStart: boolean }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const close = () => menu.current?.removeAttribute("open");
  useEffect(() => {
    const closeIfOutside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", closeIfOutside);
    return () => document.removeEventListener("pointerdown", closeIfOutside);
  }, []);
  return (
    <details ref={menu} className="relative min-w-0">
      <summary aria-label={`Espace ${current}\u00a0: changer d’espace`} className="flex cursor-pointer list-none items-center gap-1 rounded-lg border px-2.5 py-1 text-foreground transition-colors hover:bg-accent [&::-webkit-details-marker]:hidden">
        <span className="max-w-40 truncate">{current}</span>
        <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </summary>
      <div className="absolute right-0 z-20 mt-2 w-60 rounded-xl border bg-card p-1 shadow-lg" onClick={close}>
        {others.map((workspace) => (
          <form key={workspace.id} action={switchWorkspaceAction.bind(null, workspace.id)}>
            <button type="submit" className={ENTRY}>
              {workspace.name}
            </button>
          </form>
        ))}
        {mayStart && (
          <Link href="/welcome" className={`${ENTRY} text-muted-foreground`}>
            Créer un espace
          </Link>
        )}
      </div>
    </details>
  );
}
