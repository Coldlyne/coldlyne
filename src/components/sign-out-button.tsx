"use client";

import { useRouter } from "next/navigation";
import { authClient } from "@/infrastructure/auth/client";

/** Ends the session, then back to the sign-in page, or to wherever signing in again should lead. */
export function SignOutButton({ to = "/sign-in" }: { to?: string }) {
  const router = useRouter();
  return (
    <button type="button" className="shrink-0 transition-colors hover:text-foreground" onClick={() => authClient.signOut().then(() => router.push(to))}>
      Se déconnecter
    </button>
  );
}
