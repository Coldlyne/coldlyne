import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { acceptInvitation, cancelInvitation, hasLiveInvitation, invitationMail, invitationPath, inviteToWorkspace, openInvitationsOf, seeInvitation } from "@/application/invitations";
import type { Services } from "@/application/services";
import { removeMember, roleIn } from "@/application/team";
import { workspacesOf } from "@/application/workspaces";
import { sha256 } from "@/infrastructure/crypto/secrets";
import type { Database } from "@/infrastructure/db/client";
import { user } from "@/infrastructure/db/schema/auth";
import { invitation, member } from "@/infrastructure/db/schema/tenancy";
import { withWorkspace } from "@/infrastructure/db/tenant";
import type { Env } from "@/infrastructure/env";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { fakeFetch } from "./support/fetch";
import { expectFrenchTypography } from "./support/french";

const settings = { BETTER_AUTH_URL: "https://coldlyne.test", RESEND_API_KEY: "key", COLDLYNE_MAIL_FROM: "Coldlyne <contact@coldlyne.test>" } as Env;
const NOW = new Date("2026-11-05T09:00:00Z");
const LATER = new Date(NOW.getTime() + 15 * 86_400_000);
const RESEND = { match: "POST https://api.resend.com/emails", json: { id: "mail" } };

let db: Database;
let services: Services;
beforeAll(async () => {
  db = await createTestDatabase();
  services = { db, settings: { ...settings, RESEND_API_KEY: undefined }, fetch: fakeFetch([]).fetch, now: () => NOW };
});

/** An account with this address, proved unless a test says otherwise. */
async function account(email: string, emailVerified = true): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(user).values({ id, name: "Bea", email, emailVerified });
  return id;
}

const address = () => `${crypto.randomUUID()}@example.test`;

/** A workspace and the link inviting this address, as the screen shows it without a mail key. */
async function invited(email: string, role = "member") {
  const seat = await createTestWorkspace(db, "Acme");
  const result = await inviteToWorkspace(services, seat.workspaceId, seat.userId, email, role);
  if (!result.ok || !result.link) throw new Error("Not invited");
  return { ...seat, link: result.link, token: new URL(result.link).pathname.split("/").at(-1) as string };
}

describe("inviting someone", () => {
  it("keeps the address lowercased and only the token's hash, expiring in 14 days", async () => {
    const email = address();
    const { workspaceId, userId, token } = await invited(`  ${email.toUpperCase()} `);
    const [row] = await withWorkspace(db, workspaceId, (tx) => tx.select().from(invitation));
    expect(row).toMatchObject({ email, role: "member", tokenHash: sha256(token), invitedBy: userId, acceptedAt: null, expiresAt: new Date(NOW.getTime() + 14 * 86_400_000) });
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("mails the link when it can, and gives it back to nobody", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db, "Acme");
    const fake = fakeFetch([RESEND]);
    const email = address();
    const result = await inviteToWorkspace({ ...services, settings, fetch: fake.fetch }, workspaceId, userId, email, "admin");
    expect(result).toEqual({ ok: true, email, link: null });
    const sent = JSON.parse(fake.calls[0].body);
    expect(sent.to).toEqual([email]);
    expect(sent.subject).toBe("Ada vous invite à rejoindre Acme sur Coldlyne");
    expect(sent.text).toMatch(/https:\/\/coldlyne\.test\/join\/[\w-]{20,}/);
  });

  it("shows the link when there's no mail key", async () => {
    const seat = await createTestWorkspace(db);
    const result = await inviteToWorkspace(services, seat.workspaceId, seat.userId, address(), "member");
    expect(result).toMatchObject({ ok: true, link: expect.stringMatching(/^https:\/\/coldlyne\.test\/join\//) });
  });

  it("shows the link when the mail fails, rather than losing the invitation", async () => {
    const seat = await createTestWorkspace(db);
    const failing = fakeFetch([{ ...RESEND, status: 500, json: { message: "down" } }]);
    const result = await inviteToWorkspace({ ...services, settings, fetch: failing.fetch }, seat.workspaceId, seat.userId, address(), "member");
    expect(result).toMatchObject({ ok: true, link: expect.stringContaining("/join/") });
  });

  it("is for owners and admins: a member, or someone from elsewhere, can't", async () => {
    const seat = await createTestWorkspace(db);
    const memberId = await account(address());
    await db.insert(member).values({ workspaceId: seat.workspaceId, userId: memberId, role: "member" });
    const elsewhere = await createTestWorkspace(db);
    for (const actor of [memberId, elsewhere.userId]) {
      const refused = await inviteToWorkspace(services, seat.workspaceId, actor, address(), "member");
      expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("invitent") });
    }
    expect(await openInvitationsOf(db, seat.workspaceId)).toEqual([]);
  });

  it("lets an admin invite too", async () => {
    const seat = await createTestWorkspace(db);
    const adminId = await account(address());
    await db.insert(member).values({ workspaceId: seat.workspaceId, userId: adminId, role: "admin" });
    expect((await inviteToWorkspace(services, seat.workspaceId, adminId, address(), "admin")).ok).toBe(true);
  });

  it.each(["owner", "boss", ""])("can't make someone %j", async (role) => {
    const seat = await createTestWorkspace(db);
    expect((await inviteToWorkspace(services, seat.workspaceId, seat.userId, address(), role)).ok).toBe(false);
  });

  it.each(["", "nobody", "a@", "@b.fr"])("refuses the address %j", async (email) => {
    const seat = await createTestWorkspace(db);
    expect(await inviteToWorkspace(services, seat.workspaceId, seat.userId, email, "member")).toMatchObject({ ok: false, error: "Cette adresse n’est pas valide." });
  });

  it("refuses someone already there, and says so only about this workspace", async () => {
    const email = address();
    const seat = await createTestWorkspace(db);
    const present = await account(email);
    await db.insert(member).values({ workspaceId: seat.workspaceId, userId: present, role: "member" });
    expect(await inviteToWorkspace(services, seat.workspaceId, seat.userId, email.toUpperCase(), "member")).toMatchObject({ ok: false, error: expect.stringContaining("déjà") });
    const elsewhere = await createTestWorkspace(db);
    expect((await inviteToWorkspace(services, elsewhere.workspaceId, elsewhere.userId, email, "member")).ok).toBe(true);
  });

  it("replaces an open invitation when asked again: the older link stops working", async () => {
    const email = address();
    const { workspaceId, userId, token: older } = await invited(email);
    const again = await inviteToWorkspace(services, workspaceId, userId, email, "admin");
    if (!again.ok || !again.link) throw new Error("Not invited");
    const person = await account(email);
    expect(await seeInvitation(db, person, older, NOW)).toEqual({ status: "unknown" });
    expect(await seeInvitation(db, person, new URL(again.link).pathname.split("/").at(-1) as string, NOW)).toEqual({ status: "open", workspaceName: "Acme" });
    expect(await openInvitationsOf(db, workspaceId)).toEqual([expect.objectContaining({ email, role: "admin" })]);
  });

  it("writes in French, and tells a stranger to ignore it", () => {
    const { subject, text } = invitationMail({ inviter: "Ada", workspaceName: "Acme", url: "https://coldlyne.test/join/abc" });
    expect(text).toContain("https://coldlyne.test/join/abc");
    expect(text).toContain("ignorez-le");
    expectFrenchTypography(subject);
    expectFrenchTypography(text.replace("https://coldlyne.test/join/abc", ""));
  });
});

describe("a workspace's invitations", () => {
  it("are its own: another workspace sees none, and can't cancel them", async () => {
    const { workspaceId } = await invited(address());
    const other = await createTestWorkspace(db);
    expect(await openInvitationsOf(db, other.workspaceId)).toEqual([]);
    const [{ id }] = await openInvitationsOf(db, workspaceId);
    expect(await cancelInvitation(db, other.workspaceId, other.userId, id)).toMatchObject({ ok: false });
    expect(await openInvitationsOf(db, workspaceId)).toHaveLength(1);
  });

  it("can't be read by the app role without being bound to their workspace", async () => {
    const { workspaceId } = await invited(address());
    const other = await createTestWorkspace(db);
    const seen = await withWorkspace(db, other.workspaceId, (tx) => tx.select().from(invitation).where(eq(invitation.workspaceId, workspaceId)));
    expect(seen).toEqual([]);
  });

  it("can be cancelled by an owner or admin, not by a member, and the link then says nothing", async () => {
    const email = address();
    const { workspaceId, userId, token } = await invited(email);
    const [{ id }] = await openInvitationsOf(db, workspaceId);
    const plain = await account(address());
    await db.insert(member).values({ workspaceId, userId: plain, role: "member" });
    expect(await cancelInvitation(db, workspaceId, plain, id)).toMatchObject({ ok: false });
    expect(await cancelInvitation(db, workspaceId, userId, id)).toMatchObject({ ok: true });
    expect(await cancelInvitation(db, workspaceId, userId, id)).toMatchObject({ ok: false });
    const person = await account(email);
    expect(await seeInvitation(db, person, token, NOW)).toEqual({ status: "unknown" });
    expect(await acceptInvitation(db, person, token, NOW)).toEqual({ ok: false, refusal: "unknown" });
    expect(await hasLiveInvitation(db, email, NOW)).toBe(false);
  });
});

describe("whether an address has an invitation still good", () => {
  it("is yes until it expires, is used or is cancelled, however the address is written", async () => {
    const email = address();
    const { token } = await invited(email);
    expect(await hasLiveInvitation(db, email.toUpperCase(), NOW)).toBe(true);
    expect(await hasLiveInvitation(db, email, LATER)).toBe(false);
    await acceptInvitation(db, await account(email), token, NOW);
    expect(await hasLiveInvitation(db, email, NOW)).toBe(false);
  });

  it("is no for anyone else", async () => {
    await invited(address());
    expect(await hasLiveInvitation(db, address(), NOW)).toBe(false);
  });
});

describe("opening the link", () => {
  it("shows the invited address the workspace it opens", async () => {
    const email = address();
    const { token } = await invited(email);
    expect(await seeInvitation(db, await account(email), token, NOW)).toEqual({ status: "open", workspaceName: "Acme" });
  });

  it("names nothing for a garbled link", async () => {
    expect(await seeInvitation(db, await account(address()), "garbled", NOW)).toEqual({ status: "unknown" });
    expect(await acceptInvitation(db, await account(address()), "garbled", NOW)).toEqual({ ok: false, refusal: "unknown" });
  });

  it("names nothing for another address, however the link was obtained", async () => {
    const { token } = await invited(address());
    const stranger = await account(address());
    const seen = await seeInvitation(db, stranger, token, NOW);
    expect(seen).toEqual({ status: "other_address" });
    expect(JSON.stringify(seen)).not.toContain("Acme");
  });

  it("refuses an account whose address isn't proved, even the right one", async () => {
    const email = address();
    const { token, workspaceId } = await invited(email);
    const unproved = await account(email, false);
    expect(await seeInvitation(db, unproved, token, NOW)).toEqual({ status: "other_address" });
    expect(await acceptInvitation(db, unproved, token, NOW)).toEqual({ ok: false, refusal: "other_address" });
    expect(await roleIn(db, workspaceId, unproved)).toBeUndefined();
  });

  it("matches an account's address however it's written", async () => {
    const email = address();
    const { token, workspaceId } = await invited(email);
    const person = await account(email.toUpperCase());
    expect(await acceptInvitation(db, person, token, NOW)).toEqual({ ok: true, workspaceId });
  });

  it("says when it has expired", async () => {
    const email = address();
    const { token, workspaceId } = await invited(email);
    const person = await account(email);
    expect(await seeInvitation(db, person, token, LATER)).toEqual({ status: "expired" });
    expect(await acceptInvitation(db, person, token, LATER)).toEqual({ ok: false, refusal: "expired" });
    expect(await roleIn(db, workspaceId, person)).toBeUndefined();
  });
});

describe("accepting an invitation", () => {
  it("joins with the role it was sent with, into that workspace alone", async () => {
    const email = address();
    const { token, workspaceId } = await invited(email, "admin");
    await createTestWorkspace(db, "Another");
    const person = await account(email);
    expect(await acceptInvitation(db, person, token, NOW)).toEqual({ ok: true, workspaceId });
    expect(await workspacesOf(db, person)).toEqual([{ id: workspaceId, name: "Acme", role: "admin" }]);
  });

  it("works once: after that the link says it was used", async () => {
    const email = address();
    const { token } = await invited(email);
    const person = await account(email);
    await acceptInvitation(db, person, token, NOW);
    expect(await seeInvitation(db, person, token, NOW)).toEqual({ status: "used" });
    expect(await acceptInvitation(db, person, token, NOW)).toEqual({ ok: false, refusal: "used" });
  });

  it("can't bring back someone who was removed", async () => {
    const email = address();
    const { token, workspaceId, userId } = await invited(email);
    const person = await account(email);
    await acceptInvitation(db, person, token, NOW);
    await removeMember(db, workspaceId, userId, person);
    expect(await acceptInvitation(db, person, token, NOW)).toEqual({ ok: false, refusal: "used" });
    expect(await workspacesOf(db, person)).toEqual([]);
  });

  it("keeps the role of someone who got in another way meanwhile", async () => {
    const email = address();
    const { token, workspaceId } = await invited(email, "member");
    const person = await account(email);
    await db.insert(member).values({ workspaceId, userId: person, role: "admin" });
    expect(await acceptInvitation(db, person, token, NOW)).toEqual({ ok: true, workspaceId });
    expect(await roleIn(db, workspaceId, person)).toBe("admin");
  });
});

describe("the link's address", () => {
  it("is a page of the app, whatever the token", () => {
    expect(invitationPath("abc-_1")).toBe("/join/abc-_1");
    expect(invitationPath("../evil")).toBe("/join/..%2Fevil");
  });
});
