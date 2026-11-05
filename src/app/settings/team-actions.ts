"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Tried } from "@/application/connection-use";
import { cancelInvitation, inviteToWorkspace, type Invited } from "@/application/invitations";
import { changeRole, removeMember } from "@/application/team";
import { ROLES, type Role } from "@/domain/team";
import { currentSeat, forgetWorkspace } from "@/infrastructure/auth/session";
import { appServices } from "@/infrastructure/services";

/** Only here, for someone at the screen: no assistant tool reaches any of this, so nothing a reply says can grant access. */

const SETTINGS = "/settings";

export async function inviteAction(_previous: Invited | null, form: FormData): Promise<Invited> {
  const seat = await currentSeat();
  const invited = await inviteToWorkspace(appServices(), seat.workspaceId, seat.userId, String(form.get("email") ?? ""), String(form.get("role") ?? ""));
  revalidatePath(SETTINGS);
  return invited;
}

export async function cancelInvitationAction(id: string): Promise<void> {
  const seat = await currentSeat();
  await cancelInvitation(appServices().db, seat.workspaceId, seat.userId, id);
  revalidatePath(SETTINGS);
}

export async function changeRoleAction(targetId: string, _previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const role = String(form.get("role")) as Role;
  if (!ROLES.includes(role)) return { ok: false, error: "Ce rôle n’existe pas." };
  const changed = await changeRole(appServices().db, seat.workspaceId, seat.userId, targetId, role);
  revalidatePath(SETTINGS);
  return changed;
}

export async function removeMemberAction(targetId: string): Promise<void> {
  const seat = await currentSeat();
  await removeMember(appServices().db, seat.workspaceId, seat.userId, targetId);
  revalidatePath(SETTINGS);
}

/** Leaves the workspace and goes home, in the member's next one, or to /welcome if it was their only one. */
export async function leaveWorkspaceAction(): Promise<void> {
  const seat = await currentSeat();
  const left = await removeMember(appServices().db, seat.workspaceId, seat.userId, seat.userId);
  if (left.ok) await forgetWorkspace();
  redirect(left.ok ? "/" : SETTINGS);
}
