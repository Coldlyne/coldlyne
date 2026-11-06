"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

const NAV = [
  { href: "/today", label: "Aujourd’hui" },
  { href: "/lists", label: "Listes" },
  { href: "/sequences", label: "Séquences" },
  { href: "/replies", label: "Réponses" },
  { href: "/watchlists", label: "Veilles" },
  { href: "/connections", label: "Connexions" },
  { href: "/deliverability", label: "Délivrabilité" },
  { href: "/settings", label: "Réglages" },
];

/** What's reachable, and where the member is when that's known: one strip to swipe on a phone, rather than three wrapped rows. */
export function NavStrip({ pathname, className = "" }: { pathname?: string; className?: string }) {
  const strip = useRef<HTMLElement>(null);
  // On a phone the page's link may be past the edge of the strip: bring it into view.
  useEffect(() => strip.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "center" }), [pathname]);
  return (
    <nav ref={strip} aria-label="Principale" className={`flex items-center gap-0.5 overflow-x-auto text-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${className}`}>
      {NAV.map((item) => {
        const here = pathname === item.href || pathname?.startsWith(`${item.href}/`);
        return (
          <Link key={item.href} href={item.href} aria-current={here ? "page" : undefined} className={`shrink-0 rounded-full px-3 py-1.5 whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${here ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** The strip for this page. The path isn't known while a dynamic route is prerendered, so it needs a Suspense boundary around it, with `NavStrip` alone as the fallback. */
export function NavLinks({ className }: { className?: string }) {
  return <NavStrip pathname={usePathname()} className={className} />;
}
