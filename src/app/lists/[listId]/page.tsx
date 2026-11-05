import type { Metadata } from "next";
import { Fragment, Suspense } from "react";
import { connectionsWith } from "@/application/connections";
import { contactsOf, pushesOf } from "@/application/contacts";
import { listsOf, prospectsOf } from "@/application/prospects";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { TryButton } from "@/components/try-button";
import { Card } from "@/components/ui";
import { notFound } from "next/navigation";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { appServices } from "@/infrastructure/services";
import { pushToCrmAction } from "../actions";
import { ImportForm, SheetImportForm } from "./import-form";

export const metadata: Metadata = { title: "Liste" };

const STATE_NAMES: Record<string, string> = { new: "Nouveau", ready: "Prêt", in_sequence: "En séquence", replied: "A répondu", bounced: "Adresse refusée", opted_out: "Exclu", done: "Terminé" };

const when = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" });

async function List({ params }: { params: PageProps<"/lists/[listId]">["params"] }) {
  const { listId } = await params;
  const seat = await currentSeat();
  const list = (await listsOf(db(), seat.workspaceId)).find((candidate) => candidate.id === listId);
  if (!list) notFound();
  const prospects = await prospectsOf(db(), seat.workspaceId, listId);
  const contacts = await contactsOf(db(), seat.workspaceId, prospects.map((found) => found.personId));
  const services = appServices();
  const [crms, sheets, pushes] = await Promise.all([connectionsWith(services, seat.workspaceId, "push_contacts"), connectionsWith(services, seat.workspaceId, "read_sheet"), pushesOf(db(), seat.workspaceId, prospects.map((found) => found.id))]);
  return (
    <>
      <PageHeading title={list.name} />
      <div className="space-y-4">
        <Card>
          <ImportForm listId={listId} />
        </Card>
        {sheets.map((sheet) => (
          <Card key={sheet.row.id}>
            <SheetImportForm listId={listId} connectionId={sheet.row.id} label={sheet.row.label} />
          </Card>
        ))}
        {prospects.length > 0 && (
          <ul className="divide-y rounded-2xl border bg-card">
            {prospects.map((found) => (
              <li key={found.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-5 py-3 text-sm">
                <span className="font-medium">{[found.firstName, found.lastName].filter(Boolean).join(" ")}</span>
                <span className="min-w-0 truncate text-muted-foreground">
                  {found.role ? `${found.role}, ` : ""}
                  {found.company}
                </span>
                <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">{STATE_NAMES[found.state] ?? found.state}</span>
                {contacts.some((contact) => contact.personId === found.personId) && (
                  <p className="w-full truncate text-xs text-muted-foreground">
                    {contacts
                      .filter((contact) => contact.personId === found.personId)
                      .map((contact) => contact.value)
                      .join(" · ")}
                  </p>
                )}
                {crms.length > 0 && (
                  <div className="flex w-full flex-wrap items-center gap-2 pt-1">
                    {crms.map((crm) => {
                      const pushed = pushes.find((push) => push.prospectId === found.id && push.connectionId === crm.row.id);
                      return (
                        <Fragment key={crm.row.id}>
                          <TryButton action={pushToCrmAction.bind(null, listId, crm.row.id, found.id)} label={`${pushed ? "Renvoyer" : "Envoyer"} à ${crm.row.label}`} busy="Envoi…" />
                          {pushed && <span className="text-xs text-muted-foreground">Envoyé le {when.format(pushed.pushedAt)}</span>}
                        </Fragment>
                      );
                    })}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/** One list: its people, how to reach them, and a file to add more from. */
export default function ListPage({ params }: PageProps<"/lists/[listId]">) {
  return (
    <Shell>
      <Suspense fallback={<Loading />}>
        <List params={params} />
      </Suspense>
    </Shell>
  );
}
