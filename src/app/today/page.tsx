import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { tasksOf, type DayTask } from "@/application/tasks";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { ActionForm, CopyButton, TryButton } from "@/components/try-button";
import { Card, EmptyState, FIELD, QuietButton, Tag } from "@/components/ui";
import { CHANNEL_NAMES } from "@/domain/sequences";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { callAction, completeTaskAction, voicemailAction } from "./actions";
import { CheckCheck } from "lucide-react";
import { ChannelTile } from "@/components/channel-icon";

export const metadata: Metadata = { title: "Aujourd’hui" };

const isCall = (task: DayTask) => task.channel === "call" || task.channel === "voicemail";

const OUTCOMES: { value: string; label: string; call: boolean }[] = [
  { value: "answered", label: "A décroché", call: true },
  { value: "no_answer", label: "Pas de réponse", call: true },
  { value: "voicemail_left", label: "Message laissé", call: true },
  { value: "done", label: "C’est fait", call: false },
  { value: "replied", label: "A répondu", call: false },
];

function Where({ task }: { task: DayTask }) {
  if (!task.address) return null;
  if (isCall(task) || task.channel === "whatsapp") {
    return (
      <a href={task.channel === "whatsapp" ? `https://wa.me/${task.address.replace(/\D/g, "")}` : `tel:${task.address}`} className="text-link hover:underline">
        {task.address}
      </a>
    );
  }
  return (
    <a href={task.address} target="_blank" rel="noreferrer" className="text-link hover:underline">
      Ouvrir le profil
    </a>
  );
}

function Task({ task }: { task: DayTask }) {
  const outcomes = OUTCOMES.filter((outcome) => outcome.call === isCall(task) || outcome.value === "replied");
  return (
    <Card>
      <div className="flex min-w-0 items-start gap-3">
        <ChannelTile channel={task.channel} />
        <div className="min-w-0 flex-1">
          <p className="font-medium tracking-[-0.015em]">{task.person}</p>
          <p className="text-sm text-muted-foreground">
            {task.role ? `${task.role}, ` : ""}
            {task.company}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5 text-sm">
          <Tag>{CHANNEL_NAMES[task.channel]}</Tag>
          <Where task={task} />
        </div>
      </div>
      {task.text && <p className="mt-4 rounded-xl border bg-surface p-4 text-sm whitespace-pre-line">{task.text}</p>}
      <p className="mt-2 text-xs text-muted-foreground">
        <Link href={`/sequences/${task.sequenceId}`} className="hover:underline">
          {task.sequence}
        </Link>
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {task.text && <CopyButton text={task.text} />}
        {isCall(task) && <TryButton action={callAction.bind(null, task.id)} label="Appeler" busy="Appel…" />}
        {isCall(task) && task.callId && task.recordingUrl && <TryButton action={voicemailAction.bind(null, task.id)} label="Déposer le message" busy="…" />}
      </div>
      <div className="mt-3">
        <ActionForm action={completeTaskAction.bind(null, task.id)}>
          <textarea name="summary" rows={2} placeholder="Ce qui s’est dit, pour la suite (facultatif)" aria-label="Résumé" className={FIELD} />
          <div className="flex flex-wrap gap-2">
            {outcomes.map((outcome) => (
              <QuietButton key={outcome.value} type="submit" name="outcome" value={outcome.value}>
                {outcome.label}
              </QuietButton>
            ))}
          </div>
        </ActionForm>
      </div>
    </Card>
  );
}

async function Tasks() {
  const seat = await currentSeat();
  const tasks = await tasksOf(db(), seat.workspaceId, seat.userId);
  if (tasks.length === 0) return <EmptyState icon={CheckCheck} title="Rien à faire pour le moment">Coldlyne s’occupe du reste.</EmptyState>;
  return (
    <div className="space-y-4">
      {tasks.map((task) => (
        <Task key={task.id} task={task} />
      ))}
    </div>
  );
}

/** What only a person may do: a call, a LinkedIn message. Prepared here, and the sequence carries on from the answer. */
export default function TodayPage() {
  return (
    <Shell>
      <PageHeading title="Aujourd’hui">Ce que seule une personne peut faire&nbsp;: les appels et les messages sur LinkedIn, Instagram, Messenger, X et le premier WhatsApp. Le texte est prêt, et la séquence reprend dès que vous dites comment ça s’est passé.</PageHeading>
      <Suspense fallback={<Loading />}>
        <Tasks />
      </Suspense>
    </Shell>
  );
}
