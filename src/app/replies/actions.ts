"use server";

import { revalidatePath } from "next/cache";
import type { Tried } from "@/application/connection-use";
import { recordReplyByHand, recordWhatsappConsent, replyToProspect, setInterest } from "@/application/threads";
import { CHANNELS, INTERESTS, type Channel, type Interest } from "@/domain/sequences";
import { currentSeat } from "@/infrastructure/auth/session";
import { appServices } from "@/infrastructure/services";

const refresh = (prospectId: string) => {
  revalidatePath(`/replies/${prospectId}`);
  revalidatePath("/replies");
};

export async function interestAction(prospectId: string, _previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const value = String(form.get("interest") ?? "");
  const interest = INTERESTS.includes(value as Interest) ? (value as Interest) : null;
  const saved = await setInterest(appServices().db, seat.workspaceId, prospectId, interest);
  refresh(prospectId);
  return saved ? { ok: true, said: "Noté." } : { ok: false, error: "Cette personne n’existe pas." };
}

export async function replyAction(prospectId: string, _previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const replied = await replyToProspect(appServices(), seat.workspaceId, prospectId, { subject: String(form.get("subject") ?? ""), body: String(form.get("body") ?? "") });
  refresh(prospectId);
  return replied;
}

export async function noteReplyAction(prospectId: string, _previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const channel = String(form.get("channel") ?? "") as Channel;
  if (!CHANNELS.includes(channel)) return { ok: false, error: "Choisissez un canal." };
  const noted = await recordReplyByHand(appServices(), seat.workspaceId, prospectId, channel, String(form.get("text") ?? ""));
  refresh(prospectId);
  return noted;
}

export async function consentAction(prospectId: string, agreed: boolean): Promise<Tried> {
  const seat = await currentSeat();
  const services = appServices();
  const saved = await recordWhatsappConsent(services.db, seat.workspaceId, prospectId, agreed, services.now());
  refresh(prospectId);
  return saved ? { ok: true, said: agreed ? "Accord noté." : "Accord retiré." } : { ok: false, error: "Cette personne n’existe pas." };
}
