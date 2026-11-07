import { and, eq, isNull, ne } from "drizzle-orm";
import { refusalToChangeRole, refusalToRemove, type Role } from "@/domain/team";
import { user } from "@/infrastructure/db/schema/auth";
import type { Database } from "@/infrastructure/db/client";
import { apiKey, connection } from "@/infrastructure/db/schema/connections";
import { sequence, stepMessage } from "@/infrastructure/db/schema/sequences";
import { invitation, member, workspace } from "@/infrastructure/db/schema/tenancy";
import { withWorkspace } from "@/infrastructure/db/tenant";
import type { Tried } from "./connection-use";
import { groupOf } from "./groups";

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

/** The invitations someone sent and that nobody accepted yet: a link to another of their addresses would let them straight back in. Says how many. */
async function endInvitationsBy(tx: Database, workspaceId: string, userId: string): Promise<number> {
  const ended = await withWorkspace(tx, workspaceId, (own) =>
    own
      .delete(invitation)
      .where(and(eq(invitation.invitedBy, userId), isNull(invitation.acceptedAt)))
      .returning({ id: invitation.id }),
  );
  return ended.length;
}

/** The other workspaces of the group where someone has a place: from any of them they read what the group shares. Only that workspace's team can take them out of it. */
async function otherPlacesInGroup(tx: Database, workspaceId: string, userId: string): Promise<string[]> {
  const group = await groupOf(tx, workspaceId);
  if (!group) return [];
  const places = await tx
    .select({ name: workspace.name })
    .from(member)
    .innerJoin(workspace, eq(workspace.id, member.workspaceId))
    .where(and(eq(member.userId, userId), eq(workspace.directoryId, group.id), ne(workspace.id, workspaceId)));
  return places.map(({ name }) => name);
}

/** What the one who removed someone, or who left, reads. */
function removalSaid(leaving: boolean, ended: { keys: number; invitations: number }, stillIn: readonly string[]): string {
  return [
    leaving ? "Vous avez quitté cet espace." : "Cette personne n’a plus accès à cet espace.",
    ended.keys > 0 && `${leaving ? "Les clés d’API que vous aviez créées" : "Les clés d’API qu’elle avait créées"} ne fonctionnent plus.`,
    ended.invitations > 0 && `${leaving ? "Les invitations que vous aviez envoyées" : "Les invitations qu’elle avait envoyées"} sont annulées.`,
    !leaving && stillIn.length > 0 && `Elle garde sa place dans ${stillIn.join(", ")}, du même groupe, et y lit encore ce que le groupe partage.`,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Takes someone out of a workspace, themselves included when they leave. Their access ends at once: every path re-reads membership, and the keys they made and the invitations they sent go in the same transaction. */
export async function removeMember(db: Database, workspaceId: string, actorId: string, targetId: string): Promise<Tried> {
  return db.transaction(async (tx) => {
    const team = await lockedTeam(tx, workspaceId);
    const refused = refusalToRemove(team, actorId, targetId);
    if (refused) return { ok: false, error: refused };
    await tx.delete(member).where(and(eq(member.workspaceId, workspaceId), eq(member.userId, targetId)));
    // Before anything bound to the workspace: that leaves the transaction in the app role, which can't read a group.
    const stillIn = await otherPlacesInGroup(tx, workspaceId, targetId);
    const ended = { keys: await endKeysMadeBy(tx, workspaceId, targetId), invitations: await endInvitationsBy(tx, workspaceId, targetId) };
    const heir = team.find(({ role, userId }) => role === "owner" && userId !== targetId);
    if (heir) await handOver(tx, workspaceId, targetId, heir.userId);
    return { ok: true, said: removalSaid(actorId === targetId, ended, stillIn) };
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
