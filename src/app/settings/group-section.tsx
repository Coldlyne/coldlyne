import { groupOf, groupsOwnedBy } from "@/application/groups";
import { ActionForm } from "@/components/try-button";
import { Card, CardTitle, FIELD, Labelled } from "@/components/ui";
import type { Seat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { renameGroupAction } from "./actions";

/** The group this workspace is in, and its name, for whoever owns a workspace of it to change. Nothing here moves a workspace: it stays in its group. */
export async function GroupSection({ seat }: { seat: Seat }) {
  const group = await groupOf(db(), seat.workspaceId);
  if (!group) return null;
  const owns = (await groupsOwnedBy(db(), seat.userId)).some(({ id }) => id === group.id);
  return (
    <Card>
      <CardTitle>Groupe</CardTitle>
      <p className="mt-1 text-sm text-muted-foreground">Les espaces d’un groupe partagent ce qu’ils savent des entreprises et des personnes, et rien d’autre. Un espace ne change pas de groupe.</p>
      <div className="mt-4">
        {owns ? (
          <ActionForm action={renameGroupAction} submit="Enregistrer" busy="…" quiet>
            <Labelled label="Nom du groupe">
              <input name="name" required maxLength={80} defaultValue={group.name} className={FIELD} />
            </Labelled>
          </ActionForm>
        ) : (
          <p className="text-sm font-medium">{group.name}</p>
        )}
      </div>
    </Card>
  );
}
