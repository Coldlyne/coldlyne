import { and, eq } from "drizzle-orm";
import type { Database } from "@/infrastructure/db/client";
import { directory, member, workspace } from "@/infrastructure/db/schema/tenancy";
import type { Tried } from "./connection-use";

/**
 * Groups of workspaces: what they share is in `directory.ts`, this is who is in one. A workspace is in a
 * new group unless the one who answers for a group says otherwise, and it stays in its group for good.
 * Trusted path: the app role can't write a group, or read one.
 */

const GROUP_NAME_LENGTH = 80;

/** The groups where someone owns a workspace: what lets them rename one. */
export async function groupsOwnedBy(db: Database, userId: string): Promise<{ id: string; name: string }[]> {
  return db
    .selectDistinct({ id: directory.id, name: directory.name })
    .from(directory)
    .innerJoin(workspace, eq(workspace.directoryId, directory.id))
    .innerJoin(member, and(eq(member.workspaceId, workspace.id), eq(member.userId, userId), eq(member.role, "owner")))
    .orderBy(directory.name);
}

/**
 * Who answers for a group: who started it, while they own a workspace of it; otherwise whoever has
 * owned one there longest. Worked out each time rather than kept, so nobody's leaving can leave a
 * group with no one: every workspace keeps an owner.
 */
async function holderOf(db: Database, groupId: string): Promise<string | undefined> {
  const owners = await db
    .select({ userId: member.userId, founderId: directory.founderId })
    .from(member)
    .innerJoin(workspace, eq(workspace.id, member.workspaceId))
    .innerJoin(directory, eq(directory.id, workspace.directoryId))
    .where(and(eq(directory.id, groupId), eq(member.role, "owner")))
    .orderBy(member.createdAt, member.userId);
  return owners.find(({ userId, founderId }) => userId === founderId)?.userId ?? owners[0]?.userId;
}

/**
 * The groups someone may start a workspace in: those they answer for. Owning a workspace of a group
 * isn't enough. Owners are made by other owners and can be removed, while a workspace never leaves its
 * group: a space someone brought in on the strength of a role they later lost would keep them reading
 * what the group shares for good. An operator who started a customer's workspace and handed it over
 * has no say either.
 */
export async function groupsToAddTo(db: Database, userId: string): Promise<{ id: string; name: string }[]> {
  const owned = await groupsOwnedBy(db, userId);
  const holders = await Promise.all(owned.map(({ id }) => holderOf(db, id)));
  return owned.filter((_, index) => holders[index] === userId);
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
