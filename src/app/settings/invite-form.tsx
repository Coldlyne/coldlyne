"use client";

import { useActionState } from "react";
import type { Invited } from "@/application/invitations";
import { Code, INLINE_FIELD, PrimaryButton } from "@/components/ui";
import { INVITABLE_ROLES, ROLE_NAMES } from "@/domain/team";
import { inviteAction } from "./team-actions";

/** Invites by address and says what came of it: a mail on its way, or the link to pass on when no mail could leave. */
export function InviteForm() {
  const [invited, submit, pending] = useActionState<Invited | null, FormData>(inviteAction, null);
  return (
    <form action={submit} className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-3">
        <input name="email" type="email" required placeholder="adresse@entreprise.fr" aria-label="Adresse à inviter" className={`${INLINE_FIELD} min-w-0 flex-1 basis-56`} />
        <select name="role" defaultValue="member" aria-label="Rôle" className={INLINE_FIELD}>
          {INVITABLE_ROLES.map((role) => (
            <option key={role} value={role}>
              {ROLE_NAMES[role]}
            </option>
          ))}
        </select>
        <PrimaryButton type="submit" disabled={pending}>
          {pending ? "…" : "Inviter"}
        </PrimaryButton>
      </div>
      {invited && !invited.ok && (
        <p role="status" className="text-sm text-ember">
          {invited.error}
        </p>
      )}
      {invited?.ok && !invited.link && (
        <p role="status" className="text-sm text-ice">
          Invitation envoyée à {invited.email}.
        </p>
      )}
      {invited?.ok && invited.link && (
        <div role="status">
          <p className="mb-2 text-sm text-muted-foreground">Aucun mail n’a pu partir&nbsp;: copiez ce lien pour {invited.email}, il ne s’affichera plus.</p>
          <Code>{invited.link}</Code>
        </div>
      )}
    </form>
  );
}
