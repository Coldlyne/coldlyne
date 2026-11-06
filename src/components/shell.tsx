import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { mayStartWorkspace } from "@/application/workspaces";
import { currentMember, workspacesInBrowser, type Member } from "@/infrastructure/auth/session";
import { env } from "@/infrastructure/env";
import { Logo } from "./logo";
import { NavLinks, NavStrip } from "./nav-links";
import { SignOutButton } from "./sign-out-button";
import { WorkspaceMenu } from "./workspace-menu";

/** Which workspace this is and the way to another. With nothing else to reach, there's nothing to choose and nothing shows. */
async function WorkspaceSwitcher({ member }: { member: Member }) {
  const { workspaces, active } = await workspacesInBrowser(member.userId);
  const mayStart = mayStartWorkspace(member.email, env());
  if (!active || (workspaces.length === 1 && !mayStart)) return null;
  const others = workspaces.filter(({ id }) => id !== active.id).map(({ id, name, group }) => ({ id, name, group }));
  return <WorkspaceMenu current={active.name} group={active.group} others={others} mayStart={mayStart} />;
}

/** Who is signed in and where, streamed in once the session is read. */
async function WhoIsSignedIn() {
  const member = await currentMember();
  if (!member) return null;
  return (
    <span className="flex min-w-0 items-center gap-3 text-sm text-muted-foreground">
      <WorkspaceSwitcher member={member} />
      <SignOutButton compact />
    </span>
  );
}

/** The frame of the app's pages: the mark, what's reachable, who is signed in. The links sit in the bar when there's room, and in a strip of their own under it when there isn't. */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="relative isolate flex min-h-full flex-1 flex-col">
      <div aria-hidden className="absolute inset-x-0 top-0 -z-10 h-[34rem] bg-spotlight" />
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/70 backdrop-blur-xl">
        <div className="mx-auto flex h-14 w-full max-w-[76rem] items-center justify-between gap-6 px-4">
          <Link href="/" aria-label="Accueil" className="shrink-0 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            <Logo id="header" />
          </Link>
          <Suspense fallback={<NavStrip className="hidden min-w-0 flex-1 xl:flex" />}>
            <NavLinks className="hidden min-w-0 flex-1 xl:flex" />
          </Suspense>
          <Suspense>
            <WhoIsSignedIn />
          </Suspense>
        </div>
        <div className="border-t border-border/60 xl:hidden">
          <Suspense fallback={<NavStrip className="mx-auto w-full max-w-[76rem] px-3 py-1.5" />}>
            <NavLinks className="mx-auto w-full max-w-[76rem] px-3 py-1.5" />
          </Suspense>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:py-12">{children}</main>
    </div>
  );
}

/** A page's heading and the sentence that says what it's for, under where it sits when it has a parent. */
export function PageHeading({ title, eyebrow, children }: { title: string; eyebrow?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-8 md:mb-10">
      {eyebrow && <div className="mb-3">{eyebrow}</div>}
      <h1 className="pb-1 text-[2rem] leading-[1.08] font-medium tracking-[-0.042em] text-pretty text-display md:text-[2.75rem]">{title}</h1>
      {children && <p className="mt-3 max-w-2xl text-pretty text-muted-foreground">{children}</p>}
    </div>
  );
}

/** While the server reads the workspace: the light travelling along the line. */
export function Loading() {
  return (
    <div role="status" className="flex flex-col gap-3">
      <span className="font-mono text-xs text-muted-foreground">Chargement…</span>
      <span aria-hidden className="relative block h-px w-40 overflow-hidden bg-border">
        <span className="absolute inset-y-0 left-0 w-1/4 animate-travel bg-line" />
      </span>
    </div>
  );
}
