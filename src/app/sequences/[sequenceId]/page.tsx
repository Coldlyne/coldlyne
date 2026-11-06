import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { connectionsOf, type ConnectionView } from "@/application/connections";
import { messagesToReview, type MessageForReview } from "@/application/messages";
import { listsOf } from "@/application/prospects";
import { peopleOn, sequenceOf } from "@/application/sequences";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { ActionForm, ConfirmButton, TryButton } from "@/components/try-button";
import { Card, CardTitle, Eyebrow, FIELD, Labelled } from "@/components/ui";
import type { Capability } from "@/domain/connectors";
import { CHANNEL_NAMES, CONDITION_NAMES, SEQUENCE_STATUS_NAMES, STOP_REASON_NAMES, type Channel } from "@/domain/sequences";
import { currentSeat } from "@/infrastructure/auth/session";
import { appServices } from "@/infrastructure/services";
import { addStepAction, approveAllAction, approveOneAction, editMessageAction, enrollListAction, launchAction, pauseAction, removePersonAction, removeStepAction, retryAction, saveSendingAction, updateStepAction } from "../actions";
import { StepForm } from "./step-form";
import { ChannelIcon } from "@/components/channel-icon";

export const metadata: Metadata = { title: "Séquence" };

const when = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" });

type Found = NonNullable<Awaited<ReturnType<typeof sequenceOf>>>;

/** What's happening now: a button's answer goes with it, and this stays as long as it's true. */
const NOW: Partial<Record<Found["status"], string>> = {
  running: "En cours\u00a0: les envois partent par petits groupes, dans la fenêtre et les limites prévues. Une réponse arrête la séquence pour la personne et son entreprise.",
  pending_approval: "Votre assistant demande à lancer cette séquence\u00a0: relisez-la, puis lancez-la si elle vous convient.",
  paused: "En pause\u00a0: rien ne part, et chacun reprendra où il en était.",
  finished: "Terminée\u00a0: plus personne n’y est. Ajoutez une liste pour la relancer.",
};

function Actions({ found }: { found: Found }) {
  const { id, status } = found;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {(status === "draft" || status === "pending_approval") && <TryButton action={launchAction.bind(null, id)} label={status === "draft" ? "Lancer" : "Approuver et lancer"} busy="Vérifications…" />}
      {status === "running" && <TryButton action={pauseAction.bind(null, id, true)} label="Mettre en pause" busy="…" />}
      {status === "paused" && <TryButton action={pauseAction.bind(null, id, false)} label="Reprendre" busy="…" />}
      {NOW[status] && <p className="w-full text-sm text-muted-foreground">{NOW[status]}</p>}
    </div>
  );
}

const STATUS_LABELS: Record<string, string> = { sent: "envoyés", done: "faits", skipped: "sautés", to_do: "à faire", awaiting_approval: "à approuver", failed: "en échec" };

function reachedOf(found: Found, stepId: string): string {
  return found.reached
    .filter((row) => row.stepId === stepId && STATUS_LABELS[row.status])
    .map((row) => `${row.count} ${STATUS_LABELS[row.status]}`)
    .join(" · ");
}

function Steps({ found }: { found: Found }) {
  return (
    <Card>
      <CardTitle>Étapes</CardTitle>
      {found.steps.length === 0 && <p className="mt-2 text-sm text-muted-foreground">Aucune étape pour le moment.</p>}
      <ol className="mt-4 space-y-4">
        {found.steps.map((step, index) => {
          const reached = reachedOf(found, step.id);
          return (
            <li key={step.id} className="rounded-xl border bg-surface p-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span aria-hidden className="font-serif text-2xl leading-none text-frost italic">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <ChannelIcon channel={step.channel as Channel} className="size-4 text-ice" />
                <span className="font-medium">
                  <span className="sr-only">{index + 1}. </span>
                  {CHANNEL_NAMES[step.channel as Channel]}
                </span>
                <span className="text-muted-foreground">
                  {step.waitDays === 0 ? "aussitôt" : `après ${step.waitDays} j`} · {CONDITION_NAMES[step.condition].toLowerCase()}
                </span>
                {reached && <span className="w-full font-mono text-[11px] text-muted-foreground sm:ml-auto sm:w-auto">{reached}</span>}
              </div>
              {step.subject && <p className="mt-2 text-sm font-medium">{step.subject}</p>}
              <p className="mt-1 text-sm whitespace-pre-line text-muted-foreground">{step.body}</p>
              <details className="mt-3 text-sm">
                <summary className="text-muted-foreground hover:text-foreground">Modifier</summary>
                <div className="mt-3 space-y-3">
                  <StepForm action={updateStepAction.bind(null, found.id, step.id)} values={step} submit="Enregistrer" />
                  <div className="flex flex-wrap gap-2">
                    <ConfirmButton action={removeStepAction.bind(null, found.id, step.id)} label="Retirer cette étape" confirm="Confirmer : retirer cette étape" />
                  </div>
                </div>
              </details>
            </li>
          );
        })}
      </ol>
      <details className="mt-4 text-sm" open={found.steps.length === 0}>
        <summary className="font-medium">Ajouter une étape</summary>
        <div className="mt-3">
          <StepForm action={addStepAction.bind(null, found.id)} submit="Ajouter" />
        </div>
      </details>
    </Card>
  );
}

function Message({ sequenceId, message }: { sequenceId: string; message: MessageForReview }) {
  const editable = message.stepId !== null;
  return (
    <li className="rounded-xl border bg-surface p-4 text-sm">
      <p className="font-medium">
        {message.person} <span className="font-normal text-muted-foreground">· {message.company} · {CHANNEL_NAMES[message.channel as Channel]}</span>
      </p>
      {message.note && <p className="mt-2 text-ember">{message.note}</p>}
      {message.subject && <p className="mt-2 font-medium">{message.subject}</p>}
      <p className="mt-1 whitespace-pre-line text-muted-foreground">{message.body}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {message.note ? <TryButton action={retryAction.bind(null, sequenceId, message.id)} label="Relancer tel quel" busy="…" /> : <TryButton action={approveOneAction.bind(null, sequenceId, message.id)} label="Approuver" busy="…" />}
        <ConfirmButton action={removePersonAction.bind(null, sequenceId, message.enrollmentId)} label="Retirer cette personne" confirm="Confirmer : retirer de la séquence" />
      </div>
      {editable && (
        <details className="mt-3">
          <summary className="text-muted-foreground hover:text-foreground">Corriger le texte</summary>
          <div className="mt-3">
            <ActionForm action={editMessageAction.bind(null, sequenceId, { enrollmentId: message.enrollmentId, stepId: message.stepId as string })} submit="Enregistrer" busy="…" quiet>
              <input name="subject" defaultValue={message.subject ?? ""} aria-label="Objet" placeholder="Objet" className={FIELD} />
              <textarea name="body" required rows={5} defaultValue={message.body ?? ""} aria-label="Texte" className={FIELD} />
            </ActionForm>
          </div>
        </details>
      )}
    </li>
  );
}

function Queue({ found, waiting, failed }: { found: Found; waiting: MessageForReview[]; failed: MessageForReview[] }) {
  if (waiting.length === 0 && failed.length === 0) return null;
  return (
    <Card>
      {waiting.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <CardTitle className="flex-1">À approuver ({waiting.length})</CardTitle>
            <TryButton action={approveAllAction.bind(null, found.id)} label="Tout approuver" busy="…" />
          </div>
          <ul className="mt-4 space-y-3">
            {waiting.map((message) => (
              <Message key={message.id} sequenceId={found.id} message={message} />
            ))}
          </ul>
        </>
      )}
      {failed.length > 0 && (
        <>
          <CardTitle className="mt-6  first:mt-0">À corriger ({failed.length})</CardTitle>
          <ul className="mt-4 space-y-3">
            {failed.map((message) => (
              <Message key={message.id} sequenceId={found.id} message={message} />
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

async function People({ workspaceId, found }: { workspaceId: string; found: Found }) {
  const services = appServices();
  const [people, lists] = await Promise.all([peopleOn(services.db, workspaceId, found.id), listsOf(services.db, workspaceId)]);
  return (
    <Card>
      <CardTitle>Personnes ({people.length})</CardTitle>
      <div className="mt-3">
        <ActionForm action={enrollListAction.bind(null, found.id)} submit="Ajouter cette liste" busy="Ajout…" quiet>
          <select name="listId" aria-label="Liste" defaultValue="" className={FIELD}>
            <option value="" disabled>
              Choisir une liste
            </option>
            {lists.map((list) => (
              <option key={list.id} value={list.id}>
                {list.name} ({list.prospects})
              </option>
            ))}
          </select>
        </ActionForm>
      </div>
      {people.length > 0 && (
        <ul className="mt-4 divide-y rounded-xl border bg-surface text-sm">
          {people.map((row) => (
            <li key={row.enrollmentId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
              <Link href={`/replies/${row.prospectId}`} className="font-medium hover:underline">
                {row.person}
              </Link>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.company}</span>
              <span className="font-mono text-[11px] text-muted-foreground">{row.stopReason ? STOP_REASON_NAMES[row.stopReason] ?? row.stopReason : row.status === "finished" ? "Terminé" : row.status === "waiting_member" ? "Attend un membre" : row.nextDueAt ? `Prochaine étape ${when.format(row.nextDueAt)}` : "En attente du lancement"}</span>
              {(row.status === "active" || row.status === "waiting_member") && <ConfirmButton action={removePersonAction.bind(null, found.id, row.enrollmentId)} label="Retirer" confirm="Confirmer" />}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const DAYS = [
  [1, "Lun"],
  [2, "Mar"],
  [3, "Mer"],
  [4, "Jeu"],
  [5, "Ven"],
  [6, "Sam"],
  [7, "Dim"],
] as const;

function Provider({ label, name, capability, views, value }: { label: string; name: string; capability: Capability; views: ConnectionView[]; value?: string }) {
  const options = views.filter((view) => view.capabilities.includes(capability));
  if (options.length === 0) return null;
  return (
    <Labelled label={label}>
      <select name={name} defaultValue={value ?? ""} className={FIELD}>
        <option value="">Aucun</option>
        {options.map((view) => (
          <option key={view.id} value={view.id}>
            {view.label}
          </option>
        ))}
      </select>
    </Labelled>
  );
}

function Sending({ found, views }: { found: Found; views: ConnectionView[] }) {
  const mailboxes = views.filter((view) => view.capabilities.includes("send_email"));
  return (
    <Card>
      <CardTitle>Envoi</CardTitle>
      <p className="mt-1 text-sm text-muted-foreground">Les boîtes se partagent les personnes&nbsp;: chacune garde son fil avec la même boîte.</p>
      <div className="mt-4">
        <ActionForm action={saveSendingAction.bind(null, found.id)} submit="Enregistrer" busy="…" quiet className="flex flex-col gap-4">
          <Labelled label="Nom">
            <input name="name" defaultValue={found.name} className={FIELD} />
          </Labelled>
          <fieldset className="text-sm">
            <legend>Boîtes</legend>
            {mailboxes.length === 0 && (
              <p className="mt-1 text-muted-foreground">
                Aucune boîte connectée.{" "}
                <Link href="/connections" className="text-link hover:underline">
                  En connecter une
                </Link>
              </p>
            )}
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
              {mailboxes.map((view) => (
                <label key={view.id} className="flex items-center gap-2">
                  <input type="checkbox" name="email" value={view.id} defaultChecked={found.channels.email?.includes(view.id)} />
                  {view.label}
                  {view.pausedReason && <span className="text-xs text-ember">en pause</span>}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <Provider label="SMS" name="sms" capability="send_sms" views={views} value={found.channels.sms} />
            <Provider label="Courrier" name="letter" capability="post_letter" views={views} value={found.channels.letter} />
            <Provider label="WhatsApp" name="whatsapp" capability="send_whatsapp" views={views} value={found.channels.whatsapp} />
            <Provider label="Téléphonie" name="call" capability="place_call" views={views} value={found.channels.call} />
          </div>
          <fieldset className="text-sm">
            <legend>Jours d’envoi</legend>
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
              {DAYS.map(([day, name]) => (
                <label key={day} className="flex items-center gap-1.5">
                  <input type="checkbox" name="days" value={day} defaultChecked={found.window.days.includes(day)} />
                  {name}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-3">
            <Labelled label="De">
              <input name="from" type="time" defaultValue={found.window.from} className={FIELD} />
            </Labelled>
            <Labelled label="À">
              <input name="to" type="time" defaultValue={found.window.to} className={FIELD} />
            </Labelled>
            <Labelled label="Fuseau horaire">
              <input name="timezone" defaultValue={found.window.timezone} className={FIELD} />
            </Labelled>
          </div>
        </ActionForm>
      </div>
    </Card>
  );
}

async function Content({ params }: Pick<PageProps<"/sequences/[sequenceId]">, "params">) {
  const { sequenceId } = await params;
  const seat = await currentSeat();
  const services = appServices();
  const found = await sequenceOf(services.db, seat.workspaceId, sequenceId);
  if (!found) notFound();
  const [waiting, failed, views] = await Promise.all([messagesToReview(services.db, seat.workspaceId, "awaiting_approval", sequenceId), messagesToReview(services.db, seat.workspaceId, "failed", sequenceId), connectionsOf(services, seat.workspaceId)]);
  return (
    <>
      <PageHeading
        title={found.name}
        eyebrow={
          <Eyebrow>
            <Link href="/sequences" className="hover:text-foreground">
              Séquences
            </Link>{" "}
            · {SEQUENCE_STATUS_NAMES[found.status]}
          </Eyebrow>
        }
      />
      <div className="space-y-4">
        <Actions found={found} />
        <Queue found={found} waiting={waiting} failed={failed} />
        <Steps found={found} />
        <People workspaceId={seat.workspaceId} found={found} />
        <Sending found={found} views={views} />
      </div>
    </>
  );
}

/** One campaign: what it says, who is on it, how it sends, and what waits for a member. Changes apply while it runs. */
export default function SequencePage({ params }: PageProps<"/sequences/[sequenceId]">) {
  return (
    <Shell>
      <Suspense fallback={<Loading />}>
        <Content params={params} />
      </Suspense>
    </Shell>
  );
}
