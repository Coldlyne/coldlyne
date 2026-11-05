import { openInvitationsOf } from "@/application/invitations";
import { teamOf } from "@/application/team";
import { ActionForm, ConfirmButton } from "@/components/try-button";
import { Card, INLINE_FIELD } from "@/components/ui";
import { managesTeam, refusalToChangeRole, refusalToLeave, refusalToRemove, ROLE_NAMES, ROLES, type Teammate } from "@/domain/team";
import type { Seat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { InviteForm } from "./invite-form";
import { cancelInvitationAction, changeRoleAction, leaveWorkspaceAction, removeMemberAction } from "./team-actions";

type Person = Awaited<ReturnType<typeof teamOf>>[number];

/** Someone's role, as a choice when the viewer may change it to something else, otherwise as plain words. */
function RoleOf({ person, team, viewerId }: { person: Person; team: Teammate[]; viewerId: string }) {
  const choices = ROLES.filter((role) => refusalToChangeRole(team, viewerId, person.userId, role) === null);
  if (choices.length < 2) return <span className="text-sm text-muted-foreground">{ROLE_NAMES[person.role]}</span>;
  return (
    <ActionForm action={changeRoleAction.bind(null, person.userId)} submit="Changer" busy="…" quiet className="flex flex-wrap items-center gap-2">
      <select name="role" defaultValue={person.role} aria-label={`Rôle de ${person.name}`} className={INLINE_FIELD}>
        {choices.map((role) => (
          <option key={role} value={role}>
            {ROLE_NAMES[role]}
          </option>
        ))}
      </select>
    </ActionForm>
  );
}

function PersonRow({ person, team, viewerId }: { person: Person; team: Teammate[]; viewerId: string }) {
  const mayRemove = person.userId !== viewerId && refusalToRemove(team, viewerId, person.userId) === null;
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{person.name}</p>
        <p className="truncate text-xs text-muted-foreground">{person.email}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <RoleOf person={person} team={team} viewerId={viewerId} />
        {mayRemove && <ConfirmButton action={removeMemberAction.bind(null, person.userId)} label="Retirer" confirm="Retirer de l’espace" />}
      </div>
    </li>
  );
}

const dateInFrench = (date: Date) => date.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });

/** Invitations no one has answered; an expired one says so, and inviting the address again replaces it. */
async function OpenInvitations({ workspaceId, now }: { workspaceId: string; now: Date }) {
  const invitations = await openInvitationsOf(db(), workspaceId);
  if (invitations.length === 0) return null;
  return (
    <div>
      <h3 className="text-sm font-medium">Invitations en attente</h3>
      <ul className="mt-1 divide-y">
        {invitations.map((invitation) => (
          <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm">{invitation.email}</p>
              <p className="text-xs text-muted-foreground">
                {ROLE_NAMES[invitation.role]} · {invitation.expiresAt > now ? `valable jusqu’au ${dateInFrench(invitation.expiresAt)}` : "expirée"}
              </p>
            </div>
            <ConfirmButton action={cancelInvitationAction.bind(null, invitation.id)} label="Annuler" confirm="Annuler l’invitation" />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Who works in this workspace, and for those who run its team, who else may. On the screen only: granting access stays with a person. */
export async function TeamSection({ seat }: { seat: Seat }) {
  const people = await teamOf(db(), seat.workspaceId);
  const team = people.map(({ userId, role }) => ({ userId, role }));
  const manages = managesTeam(seat.role);
  const lastOwner = refusalToLeave(team, seat.userId);
  return (
    <Card>
      <h2 className="font-semibold tracking-[-0.02em]">Équipe</h2>
      <p className="mt-1 text-sm text-muted-foreground">Qui travaille dans {seat.workspaceName}. Seule une personne donne un accès, ici&nbsp;: aucun assistant ne peut inviter ni retirer quelqu’un.</p>
      <ul className="mt-3 divide-y">
        {people.map((person) => (
          <PersonRow key={person.userId} person={person} team={team} viewerId={seat.userId} />
        ))}
      </ul>
      {manages && (
        <div className="mt-5 space-y-5">
          <OpenInvitations workspaceId={seat.workspaceId} now={new Date()} />
          <div>
            <h3 className="mb-2 text-sm font-medium">Inviter quelqu’un</h3>
            <InviteForm />
          </div>
        </div>
      )}
      <div className="mt-5 flex flex-wrap items-center gap-3 border-t pt-5">
        {lastOwner ? <p className="text-sm text-muted-foreground">{lastOwner}</p> : <ConfirmButton action={leaveWorkspaceAction} label="Quitter cet espace" confirm="Quitter définitivement" />}
      </div>
    </Card>
  );
}
