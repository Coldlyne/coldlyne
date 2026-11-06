import { and, eq } from "drizzle-orm";
import { refusalToChangeRole, refusalToRemove, type Role } from "@/domain/team";
import { user } from "@/infrastructure/db/schema/auth";
import type { Database } from "@/infrastructure/db/client";
import { apiKey, connection } from "@/infrastructure/db/schema/connections";
import { sequence, stepMessage } from "@/infrastructure/db/schema/sequences";
import { member } from "@/infrastructure/db/schema/tenancy";
import { withWorkspace } from "@/infrastructure/db/tenant";
import type { Tried } from "./connection-use";

/** A workspace's members, the first to join first. Memberships are written and read on the trusted path: the app role can't write them. */
export async function teamOf(db: Database, workspaceId: string) {
  return db
    .select({ userId: member.userId, role: member.role, name: user.name, email: user.email })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.workspaceId, workspaceId))
    .orderBy(member.createdAt);
}

/** Someone's role in a workspace, read now: undefined when they aren't in it. */
export async function roleIn(db: Database, workspaceId: string, userId: string): Promise<Role | undefined> {
  const [row] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.workspaceId, workspaceId), eq(member.userId, userId)));
  return row?.role;
}

/** The team, locked until the change is made: two owners demoting each other at once must not leave a workspace with none. */
const lockedTeam = (tx: Database, workspaceId: string) => tx.select({ userId: member.userId, role: member.role }).from(member).where(eq(member.workspaceId, workspaceId)).orderBy(member.createdAt).for("update");

/**
 * What someone leaving was holding goes to an owner: the calls waiting for them and the sequences
 * that would give them more would otherwise stall where nobody sees them, and a mailbox's failures
 * would keep being mailed to someone no longer here. Last in its transaction, since it stays in the app role.
 */
async function handOver(tx: Database, workspaceId: string, from: string, to: string): Promise<void> {
  await withWorkspace(tx, workspaceId, async (own) => {
    await own
      .update(stepMessage)
      .set({ assignedTo: to })
      .where(and(eq(stepMessage.assignedTo, from), eq(stepMessage.status, "to_do")));
    await own.update(sequence).set({ createdBy: to }).where(eq(sequence.createdBy, from));
    await own.update(connection).set({ connectedBy: to }).where(eq(connection.connectedBy, from));
  });
}

/** The keys someone made stop with them: a key is shown once, so it may well have left with them. Only this workspace's, whatever group it's in. Says how many. */
async function endKeysMadeBy(tx: Database, workspaceId: string, userId: string): Promise<number> {
  const ended = await withWorkspace(tx, workspaceId, (own) => own.delete(apiKey).where(eq(apiKey.createdBy, userId)).returning({ id: apiKey.id }));
  return ended.length;
}

/** Takes someone out of a workspace, themselves included when they leave. Their access ends at once: every path re-reads membership, and the keys they made go in the same transaction. */
export async function removeMember(db: Database, workspaceId: string, actorId: string, targetId: string): Promise<Tried> {
  return db.transaction(async (tx) => {
    const team = await lockedTeam(tx, workspaceId);
    const refused = refusalToRemove(team, actorId, targetId);
    if (refused) return { ok: false, error: refused };
    await tx.delete(member).where(and(eq(member.workspaceId, workspaceId), eq(member.userId, targetId)));
    const keysEnded = await endKeysMadeBy(tx, workspaceId, targetId);
    const heir = team.find(({ role, userId }) => role === "owner" && userId !== targetId);
    if (heir) await handOver(tx, workspaceId, targetId, heir.userId);
    const left = actorId === targetId ? "Vous avez quitté cet espace." : "Cette personne n’a plus accès à cet espace.";
    return { ok: true, said: keysEnded > 0 ? `${left} ${actorId === targetId ? "Les clés d’API que vous aviez créées" : "Les clés d’API qu’elle avait créées"} ne fonctionnent plus.` : left };
  });
}

export async function changeRole(db: Database, workspaceId: string, actorId: string, targetId: string, role: Role): Promise<Tried> {
  return db.transaction(async (tx) => {
    const refused = refusalToChangeRole(await lockedTeam(tx, workspaceId), actorId, targetId, role);
    if (refused) return { ok: false, error: refused };
    await tx
      .update(member)
      .set({ role })
      .where(and(eq(member.workspaceId, workspaceId), eq(member.userId, targetId)));
    return { ok: true, said: "Enregistré." };
  });
}
