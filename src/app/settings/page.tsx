import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { memberPhoneOf, settingsOf } from "@/application/workspace-settings";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { ActionForm } from "@/components/try-button";
import { Card, FIELD, Labelled } from "@/components/ui";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { saveBriefAction, savePhoneAction, saveSendingAction } from "./actions";
import { TeamSection } from "./team-section";

export const metadata: Metadata = { title: "Réglages" };

async function Content() {
  const seat = await currentSeat();
  const [settings, phone] = await Promise.all([settingsOf(db(), seat.workspaceId), memberPhoneOf(db(), seat.workspaceId, seat.userId)]);
  const { brief } = settings;
  return (
    <div className="space-y-4">
      <Card>
        <h2 className="font-semibold tracking-[-0.02em]">Comment vous envoyez</h2>
        <p className="mt-1 text-sm text-muted-foreground">Seul un membre change ces réglages, ici&nbsp;: aucun assistant ne peut les assouplir.</p>
        <div className="mt-4">
          <ActionForm action={saveSendingAction} submit="Enregistrer" busy="…" className="flex flex-col gap-4">
            <fieldset className="space-y-2 text-sm">
              <legend>Qui décide d’envoyer</legend>
              <label className="flex items-start gap-2">
                <input type="radio" name="approval" value="autonomous" defaultChecked={settings.approval === "autonomous"} className="mt-1" />
                <span>L’assistant envoie seul sur les canaux qui passent par une API, une fois la séquence lancée.</span>
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" name="approval" value="approve_first" defaultChecked={settings.approval === "approve_first"} className="mt-1" />
                <span>Un membre approuve chaque lancement et chaque message avant qu’il parte.</span>
              </label>
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-2">
              <Labelled label="Nom de l’expéditeur" hint="Le nom légal que chaque message donne.">
                <input name="senderName" defaultValue={settings.senderName ?? ""} className={FIELD} />
              </Labelled>
              <Labelled label="Adresse de l’expéditeur" hint="Elle finit par le code postal et la ville, pour les courriers.">
                <input name="senderAddress" defaultValue={settings.senderAddress ?? ""} placeholder="12 rue de la Paix, 75002 Paris" className={FIELD} />
              </Labelled>
              <Labelled label="Limite par boîte et par jour" hint="Une nouvelle boîte commence à 10 et monte sur plusieurs semaines jusqu’à cette limite.">
                <input name="mailboxDailyCap" type="number" min={1} max={500} defaultValue={settings.mailboxDailyCap} className={FIELD} />
              </Labelled>
            </div>
          </ActionForm>
        </div>
      </Card>
      <Card>
        <h2 className="font-semibold tracking-[-0.02em]">Ce que vos assistants savent de vous</h2>
        <p className="mt-1 text-sm text-muted-foreground">Claude et ChatGPT le lisent au début de chaque conversation, et l’enrichissent quand vous le leur demandez.</p>
        <div className="mt-4">
          <ActionForm action={saveBriefAction} submit="Enregistrer" busy="…" quiet>
            <Labelled label="Qui vous visez">
              <textarea name="target" rows={2} defaultValue={brief.target ?? ""} placeholder="Les dirigeants de holdings qui gèrent plusieurs sociétés" className={FIELD} />
            </Labelled>
            <Labelled label="Ce que vous proposez">
              <textarea name="offer" rows={2} defaultValue={brief.offer ?? ""} className={FIELD} />
            </Labelled>
            <Labelled label="Ce qui le prouve">
              <textarea name="proof" rows={2} defaultValue={brief.proof ?? ""} className={FIELD} />
            </Labelled>
            <Labelled label="Votre ton">
              <input name="tone" defaultValue={brief.tone ?? ""} placeholder="Direct, sans jargon, vouvoiement" className={FIELD} />
            </Labelled>
            <Labelled label="Ce qu’il faut éviter">
              <input name="avoid" defaultValue={brief.avoid ?? ""} className={FIELD} />
            </Labelled>
          </ActionForm>
        </div>
      </Card>
      <Card>
        <h2 className="font-semibold tracking-[-0.02em]">Votre numéro</h2>
        <p className="mt-1 text-sm text-muted-foreground">Quand vous appelez depuis Coldlyne, votre téléphone sonne d’abord, puis celui du prospect.</p>
        <div className="mt-4">
          <ActionForm action={savePhoneAction} submit="Enregistrer" busy="…" quiet>
            <input name="phone" type="tel" defaultValue={phone ?? ""} placeholder="+33 6 12 34 56 78" aria-label="Votre numéro" className={FIELD} />
          </ActionForm>
        </div>
      </Card>
      <TeamSection seat={seat} />
      <p className="text-sm text-muted-foreground">
        Pour relier une autre application&nbsp;:{" "}
        <Link href="/keys" className="text-link hover:underline">
          les clés d’API
        </Link>
        .
      </p>
    </div>
  );
}

/** How the workspace sends, what assistants know of it, the member's own number, and who works in it. */
export default function SettingsPage() {
  return (
    <Shell>
      <PageHeading title="Réglages" />
      <Suspense fallback={<Loading />}>
        <Content />
      </Suspense>
    </Shell>
  );
}
