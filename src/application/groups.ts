import { and, eq } from "drizzle-orm";
import type { Database } from "@/infrastructure/db/client";
import { directory, member, workspace } from "@/infrastructure/db/schema/tenancy";
import type { Tried } from "./connection-use";

/**
 * Groups of workspaces: what they share is in `directory.ts`, this is who is in one. A workspace is in a
 * new group unless someone says otherwise, and it stays in its group for good. Trusted path: the app
 * role can't write a group, or read one.
 */

const GROUP_NAME_LENGTH = 80;

/**
 * The groups someone may start a workspace in: those where they own a workspace. Whoever owns one can
 * already let anyone into what the group shares, by inviting them there, so starting another opens
 * nothing more. An operator who started a customer's workspace and handed it over has no say any more.
 */
export async function groupsOwnedBy(db: Database, userId: string): Promise<{ id: string; name: string }[]> {
  return db
    .selectDistinct({ id: directory.id, name: directory.name })
    .from(directory)
    .innerJoin(workspace, eq(workspace.directoryId, directory.id))
    .innerJoin(member, and(eq(member.workspaceId, workspace.id), eq(member.userId, userId), eq(member.role, "owner")))
    .orderBy(directory.name);
}

/** The group a workspace is in. */
export async function groupOf(db: Database, workspaceId: string): Promise<{ id: string; name: string } | undefined> {
  const [group] = await db.select({ id: directory.id, name: directory.name }).from(directory).innerJoin(workspace, eq(workspace.directoryId, directory.id)).where(eq(workspace.id, workspaceId));
  return group;
}

/** Renames the group this workspace is in: for whoever owns a workspace of it, on the screen. */
export async function renameGroup(db: Database, workspaceId: string, actorId: string, name: string): Promise<Tried> {
  const named = name.trim().slice(0, GROUP_NAME_LENGTH);
  if (!named) return { ok: false, error: "Donnez un nom à ce groupe." };
  const group = await groupOf(db, workspaceId);
  if (!group || !(await groupsOwnedBy(db, actorId)).some(({ id }) => id === group.id)) return { ok: false, error: "Seul le propriétaire d’un espace du groupe peut le renommer." };
  await db.update(directory).set({ name: named }).where(eq(directory.id, group.id));
  return { ok: true, said: "Enregistré." };
}
