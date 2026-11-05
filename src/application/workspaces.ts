import { eq } from "drizzle-orm";
import type { Database } from "@/infrastructure/db/client";
import { member, workspace } from "@/infrastructure/db/schema/tenancy";

/** A new workspace, its creator its owner. */
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
