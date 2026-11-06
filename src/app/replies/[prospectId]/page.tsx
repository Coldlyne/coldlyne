import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { threadOf, type ThreadItem } from "@/application/threads";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { ActionForm, TryButton } from "@/components/try-button";
import { Card, CardTitle, EmptyState, Eyebrow, FIELD, Labelled } from "@/components/ui";
import { CHANNEL_NAMES, CHANNELS, INTEREST_NAMES, INTERESTS, type Channel } from "@/domain/sequences";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { consentAction, interestAction, noteReplyAction, replyAction } from "../actions";
import { MessagesSquare } from "lucide-react";
import { ChannelIcon } from "@/components/channel-icon";

export const metadata: Metadata = { title: "Conversation" };

const when = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" });

const INCOMING: Record<string, string> = { replied: "A répondu", auto_reply: "Réponse automatique", bounced: "Adresse refusée", opted_out: "Désinscription", meeting_booked: "Rendez-vous pris", meeting_cancelled: "Rendez-vous annulé", signed_up: "Inscription", delivered: "Remis", failed: "Non remis", answered: "A décroché", no_answer: "Pas de réponse", voicemail_left: "Message laissé" };
const OUTCOMES: Record<string, string> = { answered: "a décroché", no_answer: "pas de réponse", voicemail_left: "message laissé", replied: "a répondu", done: "fait" };

function Item({ item }: { item: ThreadItem }) {
  const incoming = item.direction === "in";
  return (
    <li className={`rounded-xl border p-4 text-sm ${incoming ? "border-ember/30 bg-ember/[0.06] sm:mr-10" : "bg-card sm:ml-10"}`}>
      <p className="flex flex-wrap items-center gap-x-3 font-mono text-[11px] text-muted-foreground">
        <ChannelIcon channel={item.channel as Channel} className={`size-3.5 ${incoming ? "text-ember" : "text-ice"}`} />
        <span>{CHANNEL_NAMES[item.channel as Channel] ?? item.channel}</span>
        <span>{when.format(item.at)}</span>
        <span className="ml-auto">{incoming ? (INCOMING[item.label ?? ""] ?? item.label) : item.outcome ? OUTCOMES[item.outcome] : "Envoyé"}</span>
      </p>
      {!incoming && item.label && <p className="mt-2 font-medium">{item.label}</p>}
      {item.text && <p className="mt-2 whitespace-pre-line">{item.text}</p>}
    </li>
  );
}

async function Content({ params }: Pick<PageProps<"/replies/[prospectId]">, "params">) {
  const { prospectId } = await params;
  const seat = await currentSeat();
  const thread = await threadOf(db(), seat.workspaceId, prospectId);
  if (!thread) notFound();
  return (
    <>
      <PageHeading
        title={thread.person}
        eyebrow={
          <Eyebrow>
            <Link href="/replies" className="hover:text-foreground">
              Réponses
            </Link>{" "}
            · {thread.list}
          </Eyebrow>
        }
      >
        {thread.role ? `${thread.role}, ` : ""}
        {thread.company}
      </PageHeading>
      <div className="space-y-4">
        {thread.items.length === 0 ? <EmptyState icon={MessagesSquare} title="Rien d’échangé pour le moment" /> : <ol className="space-y-3">{thread.items.map((item, index) => <Item key={index} item={item} />)}</ol>}
        <Card>
          <CardTitle>Ce que ça donne</CardTitle>
          <div className="mt-3">
            <ActionForm action={interestAction.bind(null, prospectId)} submit="Enregistrer" busy="…" quiet>
              <select name="interest" defaultValue={thread.interest ?? ""} aria-label="Ce que donne cette réponse" className={FIELD}>
                <option value="">Pas encore lu</option>
                {INTERESTS.map((value) => (
                  <option key={value} value={value}>
                    {INTEREST_NAMES[value]}
                  </option>
                ))}
              </select>
            </ActionForm>
          </div>
        </Card>
        <Card>
          <CardTitle>Répondre par email</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">Depuis la même boîte, dans le même fil.</p>
          <div className="mt-3">
            <ActionForm action={replyAction.bind(null, prospectId)} submit="Envoyer" busy="Envoi…">
              <textarea name="body" required rows={5} aria-label="Votre réponse" className={FIELD} />
            </ActionForm>
          </div>
        </Card>
        <Card>
          <CardTitle>Noter une réponse reçue ailleurs</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">Un message LinkedIn, un courrier auquel on a répondu par téléphone&nbsp;: cela arrête la séquence comme une autre réponse.</p>
          <div className="mt-3">
            <ActionForm action={noteReplyAction.bind(null, prospectId)} submit="Noter" busy="…" quiet>
              <Labelled label="Canal">
                <select name="channel" defaultValue="linkedin" className={FIELD}>
                  {CHANNELS.map((channel) => (
                    <option key={channel} value={channel}>
                      {CHANNEL_NAMES[channel]}
                    </option>
                  ))}
                </select>
              </Labelled>
              <Labelled label="Ce que la personne a dit">
                <textarea name="text" rows={2} className={FIELD} />
              </Labelled>
            </ActionForm>
          </div>
        </Card>
        <Card>
          <CardTitle>WhatsApp</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">{thread.whatsappConsent ? "Cette personne a accepté les messages WhatsApp." : "Sans son accord, le WhatsApp part de votre compte, par vous : l’API ne lui écrit pas."}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <TryButton action={consentAction.bind(null, prospectId, !thread.whatsappConsent)} label={thread.whatsappConsent ? "Retirer son accord" : "Noter son accord"} busy="…" />
          </div>
        </Card>
      </div>
    </>
  );
}

/** One person's whole conversation with the workspace, and what to do with it. */
export default function ThreadPage({ params }: PageProps<"/replies/[prospectId]">) {
  return (
    <Shell>
      <Suspense fallback={<Loading />}>
        <Content params={params} />
      </Suspense>
    </Shell>
  );
}
