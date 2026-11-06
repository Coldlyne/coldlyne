"use server";

import { revalidatePath } from "next/cache";
import type { Tried } from "@/application/connection-use";
import { renameGroup } from "@/application/groups";
import { saveMemberPhone, saveSettings } from "@/application/workspace-settings";
import { DEFAULT_DAILY_CAP } from "@/domain/sequences";
import { currentSeat } from "@/infrastructure/auth/session";
import { appServices } from "@/infrastructure/services";

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/** How this workspace sends. Only here: no assistant tool reaches it, so a prompt can't loosen it. */
export async function saveSendingAction(_previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const cap = Number(text(form, "mailboxDailyCap") || DEFAULT_DAILY_CAP);
  if (!Number.isInteger(cap) || cap < 1 || cap > 500) return { ok: false, error: "La limite d’une boîte se compte entre 1 et 500 envois par jour." };
  await saveSettings(appServices().db, seat.workspaceId, { approval: form.get("approval") === "approve_first" ? "approve_first" : "autonomous", senderName: text(form, "senderName") || null, senderAddress: text(form, "senderAddress") || null, mailboxDailyCap: cap });
  revalidatePath("/settings");
  return { ok: true, said: "Enregistré." };
}

export async function saveBriefAction(_previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  await saveSettings(appServices().db, seat.workspaceId, { brief: { target: text(form, "target"), offer: text(form, "offer"), proof: text(form, "proof"), tone: text(form, "tone"), avoid: text(form, "avoid") } });
  revalidatePath("/settings");
  return { ok: true, said: "Enregistré : vos assistants le liront en commençant." };
}

export async function savePhoneAction(_previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const phone = text(form, "phone").replace(/[\s.-]/g, "");
  if (phone && !/^\+\d{8,15}$/.test(phone)) return { ok: false, error: "Indiquez votre numéro au format international : +33 6 12 34 56 78." };
  await saveMemberPhone(appServices().db, seat.workspaceId, seat.userId, phone || null);
  revalidatePath("/settings");
  return { ok: true, said: "Enregistré." };
}

/** Renames the group this workspace is in: for whoever owns a workspace of it. */
export async function renameGroupAction(_previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const renamed = await renameGroup(appServices().db, seat.workspaceId, seat.userId, String(form.get("name") ?? ""));
  revalidatePath("/", "layout");
  return renamed;
}
