"use client";

import { useRouter } from "next/navigation";
import { authClient } from "@/infrastructure/auth/client";

/** Ends the session, then back to the sign-in page. */
export function SignOutButton() {
  const router = useRouter();
  return (
    <button type="button" className="shrink-0 transition-colors hover:text-foreground" onClick={() => authClient.signOut().then(() => router.push("/sign-in"))}>
      Se déconnecter
    </button>
  );
}
