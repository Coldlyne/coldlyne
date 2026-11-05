import "server-only";
import { getSessionCookie } from "better-auth/cookies";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { activeWorkspace, workspacesOf, type MemberWorkspace } from "@/application/workspaces";
import type { Role } from "@/domain/team";
import { db } from "../db/client";
import { env } from "../env";
import { auth } from "./server";

export interface Member {
  userId: string;
  name: string;
  email: string;
}

/** The signed-in member, or null. */
export async function currentMember(): Promise<Member | null> {
  // Headers first: a prerender stops here, before auth starts up and reaches for its identity provider.
  const requestHeaders = await headers();
  // No session to look up: auth reads the database as it starts, and a bot or an uptime check shouldn't wake it.
  if (!getSessionCookie(requestHeaders)) return null;
  const session = await auth().api.getSession({ headers: requestHeaders });
  return session ? { userId: session.user.id, name: session.user.name, email: session.user.email } : null;
}

/** Which workspace this browser is in. Only a preference: it opens nothing, since membership is read from the database each time. */
const ACTIVE_WORKSPACE_COOKIE = "coldlyne_workspace";
const A_YEAR_IN_SECONDS = 31_536_000;

/** A member's workspaces, and the one this browser is in: the first when the cookie is missing, forged or out of date. */
export async function workspacesInBrowser(userId: string): Promise<{ workspaces: MemberWorkspace[]; active: MemberWorkspace | undefined }> {
  const workspaces = await workspacesOf(db(), userId);
  return { workspaces, active: activeWorkspace(workspaces, (await cookies()).get(ACTIVE_WORKSPACE_COOKIE)?.value) };
}

/** Puts this browser in a workspace. Setting a cookie clears Next's client cache, so no page of the last workspace is shown again. Callers check membership first. */
export async function enterWorkspace(workspaceId: string): Promise<void> {
  (await cookies()).set(ACTIVE_WORKSPACE_COOKIE, workspaceId, { httpOnly: true, sameSite: "lax", secure: env().BETTER_AUTH_URL.startsWith("https:"), path: "/", maxAge: A_YEAR_IN_SECONDS });
}

/** For when someone leaves a workspace: this browser goes back to their first, and forgets what it held of the last. */
export async function forgetWorkspace(): Promise<void> {
  (await cookies()).delete(ACTIVE_WORKSPACE_COOKIE);
}

export interface Seat extends Member {
  workspaceId: string;
  workspaceName: string;
  role: Role;
}

/** The signed-in member and the workspace they're in; sent to sign in, or to create one, when they lack it. */
export async function currentSeat(): Promise<Seat> {
  const member = await currentMember();
  if (!member) redirect("/sign-in");
  const { active } = await workspacesInBrowser(member.userId);
  if (!active) redirect("/welcome");
  return { ...member, workspaceId: active.id, workspaceName: active.name, role: active.role };
}
