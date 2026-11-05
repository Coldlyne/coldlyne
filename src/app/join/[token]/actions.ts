"use server";

import { redirect } from "next/navigation";
import { acceptInvitation, invitationPath } from "@/application/invitations";
import { currentMember, enterWorkspace } from "@/infrastructure/auth/session";
import { appServices } from "@/infrastructure/services";

/** Joins the workspace and enters it. Refused, it goes back to the link's page, which says why. */
export async function joinAction(token: string): Promise<void> {
  const member = await currentMember();
  if (!member) redirect(`/sign-in?${new URLSearchParams({ next: invitationPath(token) })}`);
  const { db, now } = appServices();
  const joined = await acceptInvitation(db, member.userId, token, now());
  if (!joined.ok) redirect(invitationPath(token));
  await enterWorkspace(joined.workspaceId);
  redirect("/");
}
