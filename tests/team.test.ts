import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createApiKey, workspaceOfKey } from "@/application/api-keys";
import { changeRole, removeMember, roleIn, teamOf } from "@/application/team";
import { createWorkspace, workspacesOf } from "@/application/workspaces";
import { INVITATION_REFUSALS, managesTeam, refusalToChangeRole, refusalToLeave, refusalToRemove, type Teammate } from "@/domain/team";
import type { Database } from "@/infrastructure/db/client";
import { user } from "@/infrastructure/db/schema/auth";
import { connection } from "@/infrastructure/db/schema/connections";
import { enrollment, sequence, stepMessage } from "@/infrastructure/db/schema/sequences";
import { company, person, prospect, prospectList } from "@/infrastructure/db/schema/prospects";
import { member, workspace } from "@/infrastructure/db/schema/tenancy";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { expectFrenchTypography } from "./support/french";

const TEAM: Teammate[] = [
  { userId: "owner", role: "owner" },
  { userId: "admin", role: "admin" },
  { userId: "other-admin", role: "admin" },
  { userId: "member", role: "member" },
];

const TWO_OWNERS: Teammate[] = [...TEAM, { userId: "second-owner", role: "owner" }];

describe("who runs a team", () => {
  it("is its owners and admins", () => {
    expect(["owner", "admin", "member", undefined].map((role) => managesTeam(role as never))).toEqual([true, true, false, false]);
  });

  it("refuses a plain member, and someone who isn't there", () => {
    for (const actor of ["member", "stranger"]) {
      expect(refusalToRemove(TEAM, actor, "admin")).toContain("gèrent l’équipe");
      expect(refusalToChangeRole(TEAM, actor, "member", "admin")).toContain("gèrent l’équipe");
      expect(refusalToChangeRole(TEAM, actor, actor, "owner")).toContain("gèrent l’équipe");
    }
  });

  it("lets an admin run members and other admins, but not owners", () => {
    expect(refusalToRemove(TEAM, "admin", "member")).toBeNull();
    expect(refusalToRemove(TEAM, "admin", "other-admin")).toBeNull();
    expect(refusalToChangeRole(TEAM, "admin", "member", "admin")).toBeNull();
    expect(refusalToChangeRole(TWO_OWNERS, "admin", "second-owner", "member")).toContain("propriétaire");
    expect(refusalToRemove(TWO_OWNERS, "admin", "second-owner")).toContain("propriétaire");
  });

  it("doesn't let an admin name an owner, themselves least of all", () => {
    expect(refusalToChangeRole(TEAM, "admin", "admin", "owner")).toContain("propriétaire");
    expect(refusalToChangeRole(TEAM, "admin", "member", "owner")).toContain("propriétaire");
    expect(refusalToChangeRole(TEAM, "owner", "admin", "owner")).toBeNull();
  });

  it("says when the person is no longer there", () => {
    expect(refusalToRemove(TEAM, "owner", "gone")).toContain("n’est plus");
    expect(refusalToChangeRole(TEAM, "owner", "gone", "admin")).toContain("n’est plus");
  });
});

describe("the last owner", () => {
  it("can't be removed, demoted or leave", () => {
    expect(refusalToRemove(TEAM, "owner", "owner")).toContain("garde toujours un propriétaire");
    expect(refusalToChangeRole(TEAM, "owner", "owner", "admin")).toContain("garde toujours un propriétaire");
    expect(refusalToLeave(TEAM, "owner")).toContain("garde toujours un propriétaire");
  });

  it("can keep their role, which changes nothing", () => {
    expect(refusalToChangeRole(TEAM, "owner", "owner", "owner")).toBeNull();
  });

  it("is free once there's another", () => {
    expect(refusalToLeave(TWO_OWNERS, "owner")).toBeNull();
    expect(refusalToChangeRole(TWO_OWNERS, "owner", "owner", "member")).toBeNull();
    expect(refusalToRemove(TWO_OWNERS, "owner", "second-owner")).toBeNull();
  });

  it("doesn't stop anyone else leaving", () => {
    expect(refusalToLeave(TEAM, "member")).toBeNull();
    expect(refusalToRemove(TEAM, "member", "member")).toBeNull();
    expect(refusalToRemove(TEAM, "admin", "admin")).toBeNull();
  });
});

describe("what a team says", () => {
  it("reads as French, naming nobody", () => {
    const refusals = [refusalToRemove(TEAM, "member", "admin"), refusalToRemove(TEAM, "owner", "owner"), refusalToRemove(TWO_OWNERS, "admin", "owner"), refusalToRemove(TEAM, "owner", "gone"), ...Object.values(INVITATION_REFUSALS)];
    for (const refusal of refusals) expectFrenchTypography(refusal as string);
  });
});

describe("a workspace's team", () => {
  let db: Database;
  beforeAll(async () => {
    db = await createTestDatabase();
  });

  /** A workspace with its owner and, joining them, someone in the role asked for. */
  async function withMate(role: "owner" | "admin" | "member" = "member") {
    const { workspaceId, userId: ownerId } = await createTestWorkspace(db, "Team");
    const mateId = crypto.randomUUID();
    await db.insert(user).values({ id: mateId, name: "Bea", email: `${mateId}@example.test` });
    await db.insert(member).values({ workspaceId, userId: mateId, role });
    return { workspaceId, ownerId, mateId };
  }

  it("lists its people with their roles, the first to join first", async () => {
    const { workspaceId, ownerId, mateId } = await withMate("admin");
    expect(await teamOf(db, workspaceId)).toEqual([
      { userId: ownerId, role: "owner", name: "Ada", email: `${ownerId}@example.test` },
      { userId: mateId, role: "admin", name: "Bea", email: `${mateId}@example.test` },
    ]);
  });

  it("takes someone out, and their access with it", async () => {
    const { workspaceId, ownerId, mateId } = await withMate();
    expect(await removeMember(db, workspaceId, ownerId, mateId)).toMatchObject({ ok: true });
    expect(await workspacesOf(db, mateId)).toEqual([]);
    expect(await roleIn(db, workspaceId, mateId)).toBeUndefined();
  });

  it("refuses a plain member removing or promoting anyone, themselves included, and changes nothing", async () => {
    const { workspaceId, ownerId, mateId } = await withMate();
    expect((await removeMember(db, workspaceId, mateId, ownerId)).ok).toBe(false);
    expect((await changeRole(db, workspaceId, mateId, mateId, "owner")).ok).toBe(false);
    expect(await roleIn(db, workspaceId, ownerId)).toBe("owner");
    expect(await roleIn(db, workspaceId, mateId)).toBe("member");
  });

  it("keeps its last owner, whoever tries", async () => {
    const { workspaceId, ownerId, mateId } = await withMate("admin");
    expect((await removeMember(db, workspaceId, ownerId, ownerId)).ok).toBe(false);
    expect((await changeRole(db, workspaceId, ownerId, ownerId, "member")).ok).toBe(false);
    expect((await removeMember(db, workspaceId, mateId, ownerId)).ok).toBe(false);
    expect((await changeRole(db, workspaceId, mateId, ownerId, "member")).ok).toBe(false);
    expect(await roleIn(db, workspaceId, ownerId)).toBe("owner");
  });

  it("hands ownership over, and only then frees the first owner", async () => {
    const { workspaceId, ownerId, mateId } = await withMate();
    expect(await changeRole(db, workspaceId, ownerId, mateId, "owner")).toMatchObject({ ok: true });
    expect(await changeRole(db, workspaceId, ownerId, ownerId, "member")).toMatchObject({ ok: true });
    expect(await roleIn(db, workspaceId, ownerId)).toBe("member");
    expect((await changeRole(db, workspaceId, mateId, mateId, "member")).ok).toBe(false);
  });

  it("never lets two owners both go at once", async () => {
    const { workspaceId, ownerId, mateId } = await withMate("owner");
    const results = await Promise.all([changeRole(db, workspaceId, ownerId, mateId, "member"), changeRole(db, workspaceId, mateId, ownerId, "member")]);
    const owners = (await teamOf(db, workspaceId)).filter(({ role }) => role === "owner");
    expect(owners).toHaveLength(1);
    expect(results.filter(({ ok }) => ok)).toHaveLength(1);
  });

  it("lets a member leave, and refuses the last owner", async () => {
    const { workspaceId, ownerId, mateId } = await withMate();
    expect(await removeMember(db, workspaceId, mateId, mateId)).toMatchObject({ ok: true, said: "Vous avez quitté cet espace." });
    expect((await removeMember(db, workspaceId, ownerId, ownerId)).ok).toBe(false);
  });

  it("stays out of other workspaces: an owner elsewhere is nobody here", async () => {
    const { workspaceId, mateId } = await withMate();
    const elsewhere = await createTestWorkspace(db, "Elsewhere");
    expect((await removeMember(db, workspaceId, elsewhere.userId, mateId)).ok).toBe(false);
    expect((await changeRole(db, workspaceId, elsewhere.userId, mateId, "owner")).ok).toBe(false);
    expect(await roleIn(db, workspaceId, mateId)).toBe("member");
  });

  it("removes someone from this workspace only", async () => {
    const { workspaceId, ownerId, mateId } = await withMate();
    const theirs = await createTestWorkspace(db, "Theirs");
    await db.insert(member).values({ workspaceId: theirs.workspaceId, userId: mateId, role: "member" });
    await removeMember(db, workspaceId, ownerId, mateId);
    expect((await workspacesOf(db, mateId)).map(({ id }) => id)).toEqual([theirs.workspaceId]);
  });

  describe("what someone leaving was holding", () => {
    async function holding() {
      const seats = await withMate();
      const { workspaceId, mateId } = seats;
      const ids = await withWorkspace(db, workspaceId, async (tx) => {
        const [mine] = await tx.insert(company).values({ name: "Acme", source: "member" }).returning();
        const [someone] = await tx.insert(person).values({ companyId: mine.id, lastName: "Dupont", source: "member" }).returning();
        const [list] = await tx.insert(prospectList).values({ name: "Theirs" }).returning();
        const [held] = await tx.insert(prospect).values({ listId: list.id, personId: someone.id }).returning();
        const [made] = await tx.insert(sequence).values({ name: "Theirs", createdBy: mateId, window: { days: [1], from: "09:00", to: "18:00", timezone: "Europe/Paris" } }).returning();
        const [enrolled] = await tx.insert(enrollment).values({ sequenceId: made.id, prospectId: held.id, personId: someone.id, companyId: mine.id, status: "waiting_member" }).returning();
        const [open] = await tx.insert(stepMessage).values({ enrollmentId: enrolled.id, channel: "call", status: "to_do", assignedTo: mateId }).returning();
        const [done] = await tx.insert(stepMessage).values({ enrollmentId: enrolled.id, channel: "call", status: "done", assignedTo: mateId }).returning();
        const [mailbox] = await tx.insert(connection).values({ kind: "smtp", label: "bea@acme.fr", sealedCredentials: "sealed", hookToken: "hook", connectedBy: mateId }).returning();
        return { sequenceId: made.id, openId: open.id, doneId: done.id, mailboxId: mailbox.id };
      });
      return { ...seats, ...ids };
    }

    const heldBy = (workspaceId: string, ids: Awaited<ReturnType<typeof holding>>) =>
      withWorkspace(db, workspaceId, async (tx) => ({
        sequence: (await tx.select({ by: sequence.createdBy }).from(sequence).where(eq(sequence.id, ids.sequenceId)))[0].by,
        open: (await tx.select({ by: stepMessage.assignedTo }).from(stepMessage).where(eq(stepMessage.id, ids.openId)))[0].by,
        done: (await tx.select({ by: stepMessage.assignedTo }).from(stepMessage).where(eq(stepMessage.id, ids.doneId)))[0].by,
        mailbox: (await tx.select({ by: connection.connectedBy }).from(connection).where(eq(connection.id, ids.mailboxId)))[0].by,
      }));

    it("goes to an owner: calls waiting, later ones, and word of a failing mailbox; what they did stays theirs", async () => {
      const ids = await holding();
      await removeMember(db, ids.workspaceId, ids.ownerId, ids.mateId);
      expect(await heldBy(ids.workspaceId, ids)).toEqual({ sequence: ids.ownerId, open: ids.ownerId, done: ids.mateId, mailbox: ids.ownerId });
    });

    it("stays with them when they can't go", async () => {
      const ids = await holding();
      await removeMember(db, ids.workspaceId, ids.mateId, ids.ownerId);
      expect(await heldBy(ids.workspaceId, ids)).toEqual({ sequence: ids.mateId, open: ids.mateId, done: ids.mateId, mailbox: ids.mateId });
    });
  });
});

describe("the keys of someone leaving", () => {
  let db: Database;
  beforeAll(async () => {
    db = await createTestDatabase();
  });

  async function madeKey(workspaceId: string, userId: string, name = "Tableau de bord") {
    const made = await createApiKey(db, workspaceId, userId, name);
    if (!made.ok) throw new Error(made.error);
    return made.key;
  }

  async function adminOf(workspaceId: string) {
    const adminId = crypto.randomUUID();
    await db.insert(user).values({ id: adminId, name: "Bea", email: `${adminId}@example.test` });
    await db.insert(member).values({ workspaceId, userId: adminId, role: "admin" });
    return adminId;
  }

  async function withAdmin() {
    const { workspaceId, userId: ownerId } = await createTestWorkspace(db);
    return { workspaceId, ownerId, adminId: await adminOf(workspaceId) };
  }

  it("stop working when they're removed, and the removal says so", async () => {
    const { workspaceId, ownerId, adminId } = await withAdmin();
    const key = await madeKey(workspaceId, adminId);
    expect(await workspaceOfKey(db, key)).toBe(workspaceId);
    const removed = await removeMember(db, workspaceId, ownerId, adminId);
    expect(removed).toMatchObject({ ok: true, said: expect.stringContaining("clés d’API") });
    if (removed.ok) expectFrenchTypography(removed.said);
    expect(await workspaceOfKey(db, key)).toBeNull();
  });

  it("stop working when they leave by themselves, and it says so", async () => {
    const { workspaceId, adminId } = await withAdmin();
    const key = await madeKey(workspaceId, adminId);
    expect(await removeMember(db, workspaceId, adminId, adminId)).toMatchObject({ ok: true, said: expect.stringContaining("clés d’API") });
    expect(await workspaceOfKey(db, key)).toBeNull();
  });

  it("leave everyone else's alone, and say nothing when they made none", async () => {
    const { workspaceId, ownerId, adminId } = await withAdmin();
    const owners = await madeKey(workspaceId, ownerId);
    expect(await removeMember(db, workspaceId, ownerId, adminId)).toEqual({ ok: true, said: "Cette personne n’a plus accès à cet espace." });
    expect(await workspaceOfKey(db, owners)).toBe(workspaceId);
  });

  it("are this workspace's alone: in another of the group, what they made and what they share stay", async () => {
    const { workspaceId, ownerId, adminId } = await withAdmin();
    const [{ group }] = await db.select({ group: workspace.directoryId }).from(workspace).where(eq(workspace.id, workspaceId));
    const sister = await createWorkspace(db, ownerId, "Contoso", group);
    await db.insert(member).values({ workspaceId: sister, userId: adminId, role: "admin" });
    const here = await madeKey(workspaceId, adminId);
    const there = await madeKey(sister, adminId);
    await removeMember(db, workspaceId, ownerId, adminId);
    expect(await workspaceOfKey(db, here)).toBeNull();
    expect(await workspaceOfKey(db, there)).toBe(sister);
    expect(await roleIn(db, sister, adminId)).toBe("admin");
    const [{ stillGroup }] = await db.select({ stillGroup: workspace.directoryId }).from(workspace).where(eq(workspace.id, sister));
    expect(stillGroup).toBe(group);
  });

  it("survive a removal that was refused", async () => {
    const { workspaceId, ownerId, adminId } = await withAdmin();
    const key = await madeKey(workspaceId, ownerId);
    expect((await removeMember(db, workspaceId, ownerId, ownerId)).ok).toBe(false);
    expect((await removeMember(db, workspaceId, adminId, ownerId)).ok).toBe(false);
    expect(await workspaceOfKey(db, key)).toBe(workspaceId);
  });

  it("go in the same transaction as the removal: if they can't, the person stays", async () => {
    const { workspaceId, ownerId, adminId } = await withAdmin();
    const key = await madeKey(workspaceId, adminId);
    await db.execute(sql.raw(`create function fail_for_a_test() returns trigger language plpgsql as $$ begin raise exception 'no'; end $$`));
    await db.execute(sql.raw(`create trigger fail_for_a_test before delete on api_key for each row execute function fail_for_a_test()`));
    await expect(removeMember(db, workspaceId, ownerId, adminId)).rejects.toThrow();
    await db.execute(sql`drop trigger fail_for_a_test on api_key`);
    await db.execute(sql`drop function fail_for_a_test`);
    expect(await roleIn(db, workspaceId, adminId)).toBe("admin");
    expect(await workspaceOfKey(db, key)).toBe(workspaceId);
  });
});
