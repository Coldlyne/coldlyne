"use server";

import { redirect } from "next/navigation";
import { workspacesOf } from "@/application/workspaces";
import { currentMember, enterWorkspace } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";

/**
 * Moves this browser to another workspace of the member's; anything else leaves it where it was.
 * Home rather than the same address: a list or a sequence's page belongs to the workspace just left.
 */
export async function switchWorkspaceAction(workspaceId: string): Promise<void> {
  const member = await currentMember();
  if (!member) redirect("/sign-in");
  if ((await workspacesOf(db(), member.userId)).some(({ id }) => id === workspaceId)) await enterWorkspace(workspaceId);
  redirect("/");
}
