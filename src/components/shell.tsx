import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { mayStartWorkspace } from "@/application/workspaces";
import { currentMember, workspacesInBrowser, type Member } from "@/infrastructure/auth/session";
import { env } from "@/infrastructure/env";
import { Logo } from "./logo";
import { SignOutButton } from "./sign-out-button";
import { WorkspaceMenu } from "./workspace-menu";

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

/** Which workspace this is and the way to another. With nothing else to reach, there's nothing to choose and nothing shows. */
async function WorkspaceSwitcher({ member }: { member: Member }) {
  const { workspaces, active } = await workspacesInBrowser(member.userId);
  const mayStart = mayStartWorkspace(member.email, env());
  if (!active || (workspaces.length === 1 && !mayStart)) return null;
  const others = workspaces.filter(({ id }) => id !== active.id).map(({ id, name }) => ({ id, name }));
  return <WorkspaceMenu current={active.name} others={others} mayStart={mayStart} />;
}

/** Who is signed in and where, streamed in once the session is read. */
async function WhoIsSignedIn() {
  const member = await currentMember();
  if (!member) return null;
  return (
    <span className="flex min-w-0 items-center gap-3 text-sm text-muted-foreground">
      <WorkspaceSwitcher member={member} />
      <SignOutButton />
    </span>
  );
}

/** The frame of the app's pages: the mark, what's reachable, who is signed in. */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="relative isolate flex min-h-full flex-1 flex-col">
      <div aria-hidden className="absolute inset-x-0 top-0 -z-10 h-96 bg-glow" />
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-8 gap-y-2 px-4 py-3">
          <Link href="/" aria-label="Accueil">
            <Logo id="header" />
          </Link>
          <nav className="order-last flex w-full flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted-foreground sm:order-none sm:w-auto sm:flex-1">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} className="transition-colors hover:text-foreground">
                {item.label}
              </Link>
            ))}
          </nav>
          <Suspense>
            <WhoIsSignedIn />
          </Suspense>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 md:py-14">{children}</main>
    </div>
  );
}

/** A page's heading and the sentence that says what it's for. */
export function PageHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-10">
      <h1 className="text-3xl font-semibold tracking-[-0.04em] md:text-4xl">{title}</h1>
      {children && <p className="mt-3 max-w-2xl text-muted-foreground">{children}</p>}
    </div>
  );
}

/** Quiet placeholder while the server reads the workspace. */
export function Loading() {
  return <p className="font-mono text-xs text-muted-foreground">Chargement…</p>;
}
