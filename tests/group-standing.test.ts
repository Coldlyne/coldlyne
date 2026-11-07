import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { groupOf, groupsOwnedBy, groupsToAddTo } from "@/application/groups";
import { openInvitationsOf } from "@/application/invitations";
import { changeRole, removeMember } from "@/application/team";
import { createWorkspace, startWorkspace, workspacesOf } from "@/application/workspaces";
import type { Database } from "@/infrastructure/db/client";
import { user } from "@/infrastructure/db/schema/auth";
import { directory, invitation, member } from "@/infrastructure/db/schema/tenancy";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { createTestDatabase, createTestWorkspace } from "./support/database";

let db: Database;

beforeAll(async () => {
  db = await createTestDatabase();
});

async function person(name = "Bea") {
  const id = crypto.randomUUID();
  const email = `${id}@example.test`;
  await db.insert(user).values({ id, name, email });
  return { userId: id, email };
}

const seat = (workspaceId: string, userId: string, role: "owner" | "admin" | "member" = "owner") => db.insert(member).values({ workspaceId, userId, role });

/** A group with its first space, and a second owner made there by the one who started it. */
async function groupWithSecondOwner() {
  const { workspaceId, userId: founderId } = await createTestWorkspace(db, "First");
  const group = (await groupOf(db, workspaceId))!;
  const second = await person();
  await seat(workspaceId, second.userId);
  return { workspaceId, founderId, group, second };
}

const canAddTo = async (userId: string, groupId: string) => (await groupsToAddTo(db, userId)).some(({ id }) => id === groupId);
const startsIn = (who: { userId: string; email: string }, name: string, groupId: string) => startWorkspace(db, { COLDLYNE_ADMINS: who.email }, who, name, groupId);

describe("someone made an owner of a space, who may also start spaces", () => {
  it("can't bring a space of their own into its group: it would outlast their place there", async () => {
    const { group, second } = await groupWithSecondOwner();
    expect(await startsIn(second, "On the side", group.id)).toBeNull();
    expect(await canAddTo(second.userId, group.id)).toBe(false);
    expect(await workspacesOf(db, second.userId)).toHaveLength(1);
  });

  it("is left with nothing of the group once removed: no space, nothing to add to, nothing to rename", async () => {
    const { workspaceId, founderId, group, second } = await groupWithSecondOwner();
    await startsIn(second, "On the side", group.id);
    expect((await removeMember(db, workspaceId, founderId, second.userId)).ok).toBe(true);
    expect(await workspacesOf(db, second.userId)).toEqual([]);
    expect(await groupsOwnedBy(db, second.userId)).toEqual([]);
    expect(await startsIn(second, "Back in", group.id)).toBeNull();
  });

  it("can still start a space of their own, in a group of its own", async () => {
    const { group, second } = await groupWithSecondOwner();
    const elsewhere = await startWorkspace(db, { COLDLYNE_ADMINS: second.email }, second, "Theirs");
    expect(elsewhere).not.toBeNull();
    expect((await groupOf(db, elsewhere!))?.id).not.toBe(group.id);
  });
});

describe("who adds to a group", () => {
  it("is who started it, whichever of its spaces they own", async () => {
    const { workspaceId, founderId, group } = await groupWithSecondOwner();
    const another = await createWorkspace(db, founderId, "Second", group.id);
    expect((await groupOf(db, another))?.id).toBe(group.id);
    expect(await canAddTo(founderId, group.id)).toBe(true);
    expect(await groupOf(db, workspaceId)).toEqual(await groupOf(db, another));
  });

  it("stays who started it when they hand over the first space and keep another", async () => {
    const { workspaceId, founderId, group, second } = await groupWithSecondOwner();
    await createWorkspace(db, founderId, "Kept", group.id);
    expect((await removeMember(db, workspaceId, founderId, founderId)).ok).toBe(true);
    expect(await canAddTo(founderId, group.id)).toBe(true);
    expect(await canAddTo(second.userId, group.id)).toBe(false);
  });

  it("passes on when the one who started it owns nothing there any more: a group always has someone", async () => {
    const { workspaceId, founderId, group, second } = await groupWithSecondOwner();
    expect((await removeMember(db, workspaceId, second.userId, founderId)).ok).toBe(true);
    expect(await canAddTo(founderId, group.id)).toBe(false);
    expect(await canAddTo(second.userId, group.id)).toBe(true);
    expect(await startsIn(second, "Next", group.id)).not.toBeNull();
  });

  it("passes on the same way when they stop being an owner, and comes back to them if they do", async () => {
    const { workspaceId, founderId, group, second } = await groupWithSecondOwner();
    expect((await changeRole(db, workspaceId, second.userId, founderId, "admin")).ok).toBe(true);
    expect(await canAddTo(founderId, group.id)).toBe(false);
    expect(await canAddTo(second.userId, group.id)).toBe(true);
    expect((await changeRole(db, workspaceId, second.userId, founderId, "owner")).ok).toBe(true);
    expect(await canAddTo(founderId, group.id)).toBe(true);
    expect(await canAddTo(second.userId, group.id)).toBe(false);
  });

  it("is the longest-standing owner of a group that never said who started it", async () => {
    const { group, founderId, second } = await groupWithSecondOwner();
    await db.update(directory).set({ founderId: null }).where(eq(directory.id, group.id));
    expect(await canAddTo(founderId, group.id)).toBe(true);
    expect(await canAddTo(second.userId, group.id)).toBe(false);
  });

  it("never reaches a stranger's group, or a plain member's or an admin's", async () => {
    const { workspaceId, group } = await groupWithSecondOwner();
    const [stranger, plain, admin] = [await person(), await person(), await person()];
    await seat(workspaceId, plain.userId, "member");
    await seat(workspaceId, admin.userId, "admin");
    for (const someone of [stranger, plain, admin]) expect(await startsIn(someone, "Mine", group.id)).toBeNull();
  });
});

describe("removing someone from a space", () => {
  const openInvitation = (workspaceId: string, invitedBy: string, email: string) =>
    withWorkspace(db, workspaceId, (tx) => tx.insert(invitation).values({ email, role: "member", tokenHash: crypto.randomUUID(), expiresAt: new Date(Date.now() + 86_400_000), invitedBy }));

  it("ends the invitations they sent: a link in their hands would let them straight back in", async () => {
    const { workspaceId, founderId, second } = await groupWithSecondOwner();
    await openInvitation(workspaceId, second.userId, "their-other-address@example.test");
    await openInvitation(workspaceId, founderId, "someone-else@example.test");
    const removed = await removeMember(db, workspaceId, founderId, second.userId);
    expect(removed).toMatchObject({ ok: true, said: expect.stringContaining("invitation") });
    expect((await openInvitationsOf(db, workspaceId)).map(({ email }) => email)).toEqual(["someone-else@example.test"]);
  });

  it("says where else in the group they keep a place, since from there they still read what it shares", async () => {
    const { workspaceId, founderId, group, second } = await groupWithSecondOwner();
    const sister = await createWorkspace(db, founderId, "Sister", group.id);
    await seat(sister, second.userId, "member");
    const removed = await removeMember(db, workspaceId, founderId, second.userId);
    expect(removed).toMatchObject({ ok: true, said: expect.stringContaining("Sister") });
  });

  it("says nothing of the group when they had no other place in it", async () => {
    const { workspaceId, founderId, second } = await groupWithSecondOwner();
    const theirs = await createTestWorkspace(db, "Unrelated");
    await seat(theirs.workspaceId, second.userId, "member");
    const removed = await removeMember(db, workspaceId, founderId, second.userId);
    expect(removed).toEqual({ ok: true, said: "Cette personne n’a plus accès à cet espace." });
  });

  it("doesn't tell someone who leaves where else they are: they know", async () => {
    const { workspaceId, founderId, group, second } = await groupWithSecondOwner();
    const sister = await createWorkspace(db, founderId, "Sister", group.id);
    await seat(sister, second.userId, "member");
    expect(await removeMember(db, workspaceId, second.userId, second.userId)).toEqual({ ok: true, said: "Vous avez quitté cet espace." });
  });
});
