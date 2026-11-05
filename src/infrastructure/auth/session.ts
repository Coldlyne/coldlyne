import "server-only";
import { getSessionCookie } from "better-auth/cookies";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { workspacesOf } from "@/application/workspaces";
import { db } from "../db/client";
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

export interface Seat extends Member {
  workspaceId: string;
  workspaceName: string;
}

/** The signed-in member and their workspace; sent to sign in, or to create one, when they lack it. */
export async function currentSeat(): Promise<Seat> {
  const member = await currentMember();
  if (!member) redirect("/sign-in");
  const [workspace] = await workspacesOf(db(), member.userId);
  if (!workspace) redirect("/welcome");
  return { ...member, workspaceId: workspace.id, workspaceName: workspace.name };
}
