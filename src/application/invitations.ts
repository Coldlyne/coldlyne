import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { INVITABLE_ROLES, managesTeam, type InvitationRefusal, type Role } from "@/domain/team";
import { randomToken, sha256 } from "@/infrastructure/crypto/secrets";
import type { Database } from "@/infrastructure/db/client";
import { user } from "@/infrastructure/db/schema/auth";
import { invitation, member, workspace } from "@/infrastructure/db/schema/tenancy";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { sendOwnMail } from "@/infrastructure/mail/own-mail";
import type { Tried } from "./connection-use";
import type { Services } from "./services";
import { roleIn, teamOf } from "./team";

const DAYS_TO_ANSWER = 14;
const DAY_MILLISECONDS = 86_400_000;

const NOT_ALLOWED = "Seuls les propriétaires et les administrateurs invitent dans cet espace.";

export const normalizedEmail = (email: string) => email.trim().toLowerCase();

export const invitationPath = (token: string) => `/join/${encodeURIComponent(token)}`;

/** The invitation a member sends, in plain words; a stranger who receives it by mistake can ignore it. */
export function invitationMail({ inviter, workspaceName, url }: { inviter: string; workspaceName: string; url: string }) {
  return {
    subject: `${inviter} vous invite à rejoindre ${workspaceName} sur Coldlyne`,
    text: `Bonjour,\n\n${inviter} vous invite à rejoindre l’espace ${workspaceName} sur Coldlyne. Ouvrez ce lien dans les ${DAYS_TO_ANSWER} jours :\n${url}\n\nConnectez-vous ou créez votre compte avec cette adresse : l’invitation ne vaut que pour elle.\n\nSi vous ne vous attendiez pas à ce message, ignorez-le.`,
  };
}

export type Invited = { ok: true; email: string; link: string | null } | { ok: false; error: string };

/** A fresh invitation for this address, replacing any still open so an older link stops working. Only its hash is kept. */
async function saveInvitation(services: Services, workspaceId: string, inviterId: string, email: string, role: Role): Promise<string> {
  const token = randomToken(32);
  const expiresAt = new Date(services.now().getTime() + DAYS_TO_ANSWER * DAY_MILLISECONDS);
  await withWorkspace(services.db, workspaceId, async (tx) => {
    await tx.delete(invitation).where(and(eq(invitation.email, email), isNull(invitation.acceptedAt)));
    await tx.insert(invitation).values({ email, role, tokenHash: sha256(token), expiresAt, invitedBy: inviterId });
  });
  return token;
}

/** Whether the mail left: a failing Resend mustn't lose the invitation, whose link the screen can still show. */
async function mailInvitation(services: Services, to: string, content: Parameters<typeof invitationMail>[0]): Promise<boolean> {
  return sendOwnMail(services.settings, services.fetch, { to, ...invitationMail(content) }).catch(() => false);
}

/**
 * Invites someone to a workspace by their address. The link goes by mail; `link` carries it back only
 * when no mail left, for the inviter to pass on. It reaches their screen and nothing else: no tool
 * invites, since replies and websites can carry instructions and access stays a member's decision.
 */
export async function inviteToWorkspace(services: Services, workspaceId: string, inviterId: string, address: string, role: string): Promise<Invited> {
  const email = normalizedEmail(address);
  if (!z.email().safeParse(email).success) return { ok: false, error: "Cette adresse n’est pas valide." };
  const team = await teamOf(services.db, workspaceId);
  const inviter = team.find(({ userId }) => userId === inviterId);
  if (!inviter || !managesTeam(inviter.role)) return { ok: false, error: NOT_ALLOWED };
  if (!(INVITABLE_ROLES as readonly string[]).includes(role)) return { ok: false, error: "On invite un administrateur ou un membre." };
  if (team.some((teammate) => normalizedEmail(teammate.email) === email)) return { ok: false, error: "Cette personne est déjà dans cet espace." };
  const [place] = await services.db.select({ name: workspace.name }).from(workspace).where(eq(workspace.id, workspaceId));
  const token = await saveInvitation(services, workspaceId, inviterId, email, role as Role);
  const link = new URL(invitationPath(token), services.settings.BETTER_AUTH_URL).toString();
  const mailed = await mailInvitation(services, email, { inviter: inviter.name, workspaceName: place.name, url: link });
  return { ok: true, email, link: mailed ? null : link };
}

/** A workspace's invitations no one has answered, expired ones included until someone sends them again or cancels them. */
export async function openInvitationsOf(db: Database, workspaceId: string) {
  return withWorkspace(db, workspaceId, (tx) => tx.select({ id: invitation.id, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt }).from(invitation).where(isNull(invitation.acceptedAt)).orderBy(desc(invitation.createdAt)));
}

export async function cancelInvitation(db: Database, workspaceId: string, actorId: string, id: string): Promise<Tried> {
  if (!managesTeam(await roleIn(db, workspaceId, actorId))) return { ok: false, error: NOT_ALLOWED };
  const cancelled = await withWorkspace(db, workspaceId, (tx) =>
    tx
      .delete(invitation)
      .where(and(eq(invitation.id, id), isNull(invitation.acceptedAt)))
      .returning({ id: invitation.id }),
  );
  return cancelled.length > 0 ? { ok: true, said: "Invitation annulée." } : { ok: false, error: "Cette invitation n’est plus ouverte." };
}

/** Whether this address has an invitation still good: what lets someone get an account while Coldlyne is private. Trusted path, before any workspace is known. */
export async function hasLiveInvitation(db: Database, email: string, now: Date): Promise<boolean> {
  const [live] = await db
    .select({ id: invitation.id })
    .from(invitation)
    .where(and(eq(invitation.email, normalizedEmail(email)), isNull(invitation.acceptedAt), gt(invitation.expiresAt, now)))
    .limit(1);
  return Boolean(live);
}

type InvitationRow = Pick<typeof invitation.$inferSelect, "acceptedAt" | "expiresAt" | "email">;

/**
 * Why this account can't use this invitation, or null. The account is read from the database rather
 * than the session, and its address must be proved: the link is good for one address and no other.
 */
async function refusalOf(db: Database, row: InvitationRow | undefined, userId: string, now: Date): Promise<InvitationRefusal | null> {
  if (!row) return "unknown";
  if (row.acceptedAt) return "used";
  if (row.expiresAt <= now) return "expired";
  const [account] = await db.select({ email: user.email, verified: user.emailVerified }).from(user).where(eq(user.id, userId));
  return account?.verified && normalizedEmail(account.email) === row.email ? null : "other_address";
}

export type InvitationSeen = { status: "open"; workspaceName: string } | { status: InvitationRefusal };

/** What a signed-in person sees at an invitation's link. Trusted path: the link comes before any workspace is known. */
export async function seeInvitation(db: Database, userId: string, token: string, now: Date): Promise<InvitationSeen> {
  const [row] = await db
    .select({ acceptedAt: invitation.acceptedAt, expiresAt: invitation.expiresAt, email: invitation.email, workspaceName: workspace.name })
    .from(invitation)
    .innerJoin(workspace, eq(workspace.id, invitation.workspaceId))
    .where(eq(invitation.tokenHash, sha256(token)));
  const refused = await refusalOf(db, row, userId, now);
  return refused ? { status: refused } : { status: "open", workspaceName: row.workspaceName };
}

export type Joined = { ok: true; workspaceId: string } | { ok: false; refusal: InvitationRefusal };

/** Joins the workspace an invitation is for, once: the row is locked so the same link can't be used twice at once. */
export async function acceptInvitation(db: Database, userId: string, token: string, now: Date): Promise<Joined> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(invitation).where(eq(invitation.tokenHash, sha256(token))).for("update");
    const refused = await refusalOf(tx, row, userId, now);
    if (refused) return { ok: false, refusal: refused };
    await tx.insert(member).values({ workspaceId: row.workspaceId, userId, role: row.role }).onConflictDoNothing();
    await tx.update(invitation).set({ acceptedAt: now }).where(eq(invitation.id, row.id));
    return { ok: true, workspaceId: row.workspaceId };
  });
}
