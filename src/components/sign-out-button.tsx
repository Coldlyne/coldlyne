"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { authClient } from "@/infrastructure/auth/client";

/** Ends the session, then back to the sign-in page, or to wherever signing in again should lead. In the bar it shrinks to its icon on a phone. */
export function SignOutButton({ to = "/sign-in", compact = false }: { to?: string; compact?: boolean }) {
  const router = useRouter();
  return (
    <button type="button" className="inline-flex shrink-0 items-center gap-1.5 rounded-full outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50" onClick={() => authClient.signOut().then(() => router.push(to))}>
      {compact && <LogOut aria-hidden className="size-4 sm:hidden" />}
      <span className={compact ? "sr-only sm:not-sr-only" : ""}>Se déconnecter</span>
    </button>
  );
}
