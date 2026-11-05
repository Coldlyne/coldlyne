import { eq } from "drizzle-orm";
import type { Database } from "@/infrastructure/db/client";
import { member, workspace } from "@/infrastructure/db/schema/tenancy";
import { isAdmin, type Env } from "@/infrastructure/env";

const WORKSPACE_NAME_LENGTH = 80;

/** A new workspace, its creator its owner. It starts empty: no brief, no mailbox, nothing from their other workspaces. */
export async function createWorkspace(db: Database, userId: string, name: string): Promise<string> {
  const slug = `${name.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace"}-${crypto.randomUUID().slice(0, 6)}`;
  return db.transaction(async (tx) => {
    const [created] = await tx.insert(workspace).values({ name: name.trim(), slug }).returning({ id: workspace.id });
    await tx.insert(member).values({ workspaceId: created.id, userId, role: "owner" });
    return created.id;
  });
}

/** The workspaces someone belongs to, the first they joined first. */
export async function workspacesOf(db: Database, userId: string) {
  return db
    .select({ id: workspace.id, name: workspace.name, role: member.role })
    .from(member)
    .innerJoin(workspace, eq(workspace.id, member.workspaceId))
    .where(eq(member.userId, userId))
    .orderBy(member.createdAt);
}

export type MemberWorkspace = Awaited<ReturnType<typeof workspacesOf>>[number];

/** Whether someone may start a workspace, their first or another: an instance's admins may; an invited member only joins. */
export const mayStartWorkspace = (email: string, settings: Pick<Env, "COLDLYNE_ADMINS">) => isAdmin(email, settings);

/** A workspace started by someone who may, or null. */
export async function startWorkspace(db: Database, settings: Pick<Env, "COLDLYNE_ADMINS">, person: { userId: string; email: string }, name: string): Promise<string | null> {
  const named = name.trim().slice(0, WORKSPACE_NAME_LENGTH);
  return named && mayStartWorkspace(person.email, settings) ? createWorkspace(db, person.userId, named) : null;
}

/** The workspace a browser is in: the one it asked for if its member belongs there, otherwise their first. */
export const activeWorkspace = (workspaces: MemberWorkspace[], wanted: string | undefined): MemberWorkspace | undefined => workspaces.find(({ id }) => id === wanted) ?? workspaces[0];

/**
 * The workspace an assistant's call names, by id or exact name, among those its member belongs to.
 * Null when it names none of them, or could be two: an assistant must never land somewhere by default.
 * Naming nothing only works with one workspace, where there is nothing to choose.
 */
export function workspaceNamed(workspaces: MemberWorkspace[], named: string | undefined): MemberWorkspace | null {
  if (named === undefined) return workspaces.length === 1 ? workspaces[0] : null;
  const matches = workspaces.filter(({ id, name }) => id === named || name === named);
  return matches.length === 1 ? matches[0] : null;
}
