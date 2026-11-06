/** Who may do what in a workspace's team. Being in a workspace is what opens its data; the role only says who runs its team. */

export type Role = "owner" | "admin" | "member";

export const ROLES = ["owner", "admin", "member"] as const satisfies readonly Role[];

export const ROLE_NAMES: Record<Role, string> = { owner: "Propriétaire", admin: "Administrateur", member: "Membre" };

/** What an invitation can make someone. Ownership is handed over by an owner, to someone already there. */
export const INVITABLE_ROLES = ["admin", "member"] as const satisfies readonly Role[];

export interface Teammate {
  userId: string;
  role: Role;
}

export const managesTeam = (role: Role | undefined) => role === "owner" || role === "admin";

export const managesApiKeys = managesTeam;

export const NOT_A_MANAGER_OF_KEYS = "Seuls les propriétaires et les administrateurs gèrent les clés d’API.";

const NOT_A_MANAGER = "Seuls les propriétaires et les administrateurs gèrent l’équipe.";
const OWNERS_ONLY = "Seul un propriétaire peut nommer, changer ou retirer un propriétaire.";
const LAST_OWNER = "Un espace garde toujours un propriétaire : nommez-en un autre d’abord.";
const NOT_THERE = "Cette personne n’est plus dans cet espace.";

const roleOf = (team: Teammate[], userId: string) => team.find((teammate) => teammate.userId === userId)?.role;
const isLastOwner = (team: Teammate[], userId: string) => roleOf(team, userId) === "owner" && team.filter(({ role }) => role === "owner").length === 1;

/** Admins run the team but not its owners: otherwise an admin could name themselves owner and remove the one who invited them. */
function refusalToManage(team: Teammate[], actorId: string, targetId: string): string | null {
  const actor = roleOf(team, actorId);
  const target = roleOf(team, targetId);
  if (!managesTeam(actor)) return NOT_A_MANAGER;
  if (!target) return NOT_THERE;
  if (target === "owner" && actor !== "owner") return OWNERS_ONLY;
  return isLastOwner(team, targetId) ? LAST_OWNER : null;
}

/** Anyone may leave, except the workspace's last owner: it would belong to nobody. */
export const refusalToLeave = (team: Teammate[], userId: string): string | null => (isLastOwner(team, userId) ? LAST_OWNER : null);

export const refusalToRemove = (team: Teammate[], actorId: string, targetId: string): string | null => (actorId === targetId ? refusalToLeave(team, actorId) : refusalToManage(team, actorId, targetId));

export function refusalToChangeRole(team: Teammate[], actorId: string, targetId: string, role: Role): string | null {
  const actor = roleOf(team, actorId);
  if (!managesTeam(actor)) return NOT_A_MANAGER;
  if (role === roleOf(team, targetId)) return null;
  if (role === "owner" && actor !== "owner") return OWNERS_ONLY;
  return refusalToManage(team, actorId, targetId);
}

/** Why an invitation link doesn't let someone in. It names nobody and no workspace: whoever holds the link may be anyone. */
export const INVITATION_REFUSALS = {
  unknown: "Ce lien n’est pas valable, ou l’invitation a été annulée.",
  used: "Cette invitation a déjà servi.",
  expired: "Cette invitation a expiré : demandez-en une nouvelle à la personne qui vous l’a envoyée.",
  other_address: "Cette invitation a été envoyée à une autre adresse que celle de votre compte. Connectez-vous avec l’adresse qui l’a reçue.",
} as const;

export type InvitationRefusal = keyof typeof INVITATION_REFUSALS;
