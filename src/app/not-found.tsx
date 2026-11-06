import type { Metadata } from "next";
import Link from "next/link";
import { AuthFrame } from "@/components/auth-frame";
import { PRIMARY_BUTTON } from "@/components/ui";

export const metadata: Metadata = { title: "Page introuvable" };

/** A record that isn't this workspace's, or an address that doesn't exist: both end here, saying nothing about which. */
export default function NotFound() {
  return (
    <AuthFrame id="not-found">
      <p className="mt-10 font-mono text-xs tracking-wider text-muted-foreground">404</p>
      <h1 className="mt-3 pb-1 text-center text-4xl font-medium tracking-[-0.045em] text-display md:text-5xl">Page introuvable</h1>
      <p className="mt-3 max-w-sm text-center text-sm text-muted-foreground">Cette page n’existe pas, ou elle appartient à un autre espace.</p>
      <Link href="/" className={`${PRIMARY_BUTTON} mt-7`}>
        Retour à l’accueil
      </Link>
    </AuthFrame>
  );
}
