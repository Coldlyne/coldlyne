"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Tried } from "@/application/connection-use";
import { enroll, removeFromSequence } from "@/application/enrollments";
import { approveMessages, messagesToReview, retryMessage, writeMessage } from "@/application/messages";
import { prospectsOf } from "@/application/prospects";
import { tickWorkspace } from "@/application/scheduler";
import { addStep, createSequence, launchSequence, removeStep, setPaused, updateSequence, updateStep, type StepInput } from "@/application/sequences";
import { settingsOf } from "@/application/workspace-settings";
import { CHANNELS, STEP_CONDITIONS, type Channel, type SendingWindow, type StepCondition } from "@/domain/sequences";
import { currentSeat } from "@/infrastructure/auth/session";
import { appServices } from "@/infrastructure/services";

const pathOf = (sequenceId: string) => `/sequences/${sequenceId}`;
const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/** A new sequence, empty: its steps are written on its page. */
export async function createSequenceAction(form: FormData): Promise<void> {
  const seat = await currentSeat();
  const created = await createSequence(appServices(), seat.workspaceId, seat.userId, { name: text(form, "name"), steps: [] });
  if (created.ok) redirect(pathOf(created.id));
}

function stepOf(form: FormData): StepInput {
  const channel = text(form, "channel") as Channel;
  const condition = text(form, "condition") as StepCondition;
  const parameters = text(form, "parameters");
  return {
    channel: CHANNELS.includes(channel) ? channel : "email",
    waitDays: Number(text(form, "waitDays") || 0),
    condition: STEP_CONDITIONS.includes(condition) ? condition : "always",
    subject: text(form, "subject") || null,
    body: String(form.get("body") ?? ""),
    options: {
      ...(text(form, "template") ? { template: text(form, "template"), language: text(form, "language") || "fr" } : {}),
      ...(parameters ? { parameters: parameters.split("|").map((parameter) => parameter.trim()) } : {}),
      ...(text(form, "recordingUrl") ? { recordingUrl: text(form, "recordingUrl") } : {}),
    },
  };
}

export async function addStepAction(sequenceId: string, _previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const added = await addStep(appServices().db, seat.workspaceId, sequenceId, stepOf(form));
  revalidatePath(pathOf(sequenceId));
  return added.ok ? { ok: true, said: "Étape ajoutée." } : added;
}

export async function updateStepAction(sequenceId: string, stepId: string, _previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const updated = await updateStep(appServices().db, seat.workspaceId, stepId, stepOf(form));
  revalidatePath(pathOf(sequenceId));
  return updated.ok ? { ok: true, said: "Étape enregistrée. Ce qui n’est pas parti suivra ce texte." } : updated;
}

export async function removeStepAction(sequenceId: string, stepId: string): Promise<void> {
  const seat = await currentSeat();
  const services = appServices();
  await removeStep(services.db, seat.workspaceId, stepId, services.now());
  revalidatePath(pathOf(sequenceId));
}

function windowOf(form: FormData): SendingWindow {
  return { days: form.getAll("days").map(Number), from: text(form, "from"), to: text(form, "to"), timezone: text(form, "timezone") || "Europe/Paris" };
}

/** Which connections a sequence sends through, and when. */
export async function saveSendingAction(sequenceId: string, _previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const optional = (name: string) => text(form, name) || undefined;
  const channels = { email: form.getAll("email").map(String), sms: optional("sms"), letter: optional("letter"), whatsapp: optional("whatsapp"), call: optional("call") };
  const updated = await updateSequence(appServices(), seat.workspaceId, sequenceId, { name: optional("name"), channels, window: windowOf(form) });
  revalidatePath(pathOf(sequenceId));
  return updated.ok ? { ok: true, said: "Enregistré." } : updated;
}

export async function enrollListAction(sequenceId: string, _previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const services = appServices();
  const listId = text(form, "listId");
  if (!listId) return { ok: false, error: "Choisissez une liste." };
  const prospects = await prospectsOf(services.db, seat.workspaceId, listId);
  const result = await enroll(services.db, seat.workspaceId, sequenceId, prospects.map((found) => found.id), services.now());
  revalidatePath(pathOf(sequenceId));
  if (!result) return { ok: false, error: "Cette séquence n’existe pas." };
  const left = result.skipped.map((found) => `${found.name} : ${found.why}`).join("\n");
  return { ok: true, said: `${result.enrolled} ${result.enrolled > 1 ? "personnes ajoutées" : "personne ajoutée"}.${left ? `\n${left}` : ""}` };
}

/** A member starts a sequence. Where the workspace approves first, its first messages wait for them right away. */
export async function launchAction(sequenceId: string): Promise<Tried> {
  const seat = await currentSeat();
  const services = appServices();
  const launched = await launchSequence(services, seat.workspaceId, sequenceId, "member");
  if (!launched.ok) return { ok: false, error: launched.problems.join("\n") };
  const { approval } = await settingsOf(services.db, seat.workspaceId);
  if (approval === "approve_first") await tickWorkspace(services, seat.workspaceId);
  revalidatePath(pathOf(sequenceId));
  return { ok: true, said: approval === "approve_first" ? "Lancée : les messages attendent votre accord ci-dessous." : "Lancée : les envois partent dans les prochaines minutes, dans la fenêtre et les limites prévues." };
}

export async function pauseAction(sequenceId: string, paused: boolean): Promise<Tried> {
  const seat = await currentSeat();
  const changed = await setPaused(appServices().db, seat.workspaceId, sequenceId, paused);
  revalidatePath(pathOf(sequenceId));
  return changed ? { ok: true, said: paused ? "En pause." : "Reprise." } : { ok: false, error: "Cette séquence a déjà changé d’état." };
}

export async function approveOneAction(sequenceId: string, messageId: string): Promise<Tried> {
  const seat = await currentSeat();
  const services = appServices();
  const approved = await approveMessages(services.db, seat.workspaceId, seat.userId, [messageId], services.now());
  revalidatePath(pathOf(sequenceId));
  return approved ? { ok: true, said: "Approuvé." } : { ok: false, error: "Ce message n’attend plus d’accord." };
}

export async function approveAllAction(sequenceId: string): Promise<Tried> {
  const seat = await currentSeat();
  const services = appServices();
  const waiting = await messagesToReview(services.db, seat.workspaceId, "awaiting_approval", sequenceId);
  const approved = await approveMessages(services.db, seat.workspaceId, seat.userId, waiting.map((message) => message.id), services.now());
  revalidatePath(pathOf(sequenceId));
  return { ok: true, said: `${approved} ${approved > 1 ? "messages approuvés" : "message approuvé"}.` };
}

/** A member's own words for one person: a correction, or better than the step's text. */
export async function editMessageAction(sequenceId: string, target: { enrollmentId: string; stepId: string }, _previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const services = appServices();
  const written = await writeMessage(services.db, seat.workspaceId, target, { subject: text(form, "subject") || null, body: String(form.get("body") ?? "") }, "member", services.now());
  revalidatePath(pathOf(sequenceId));
  return written.ok ? { ok: true, said: "Enregistré." } : written;
}

export async function retryAction(sequenceId: string, messageId: string): Promise<Tried> {
  const seat = await currentSeat();
  const services = appServices();
  const retried = await retryMessage(services.db, seat.workspaceId, messageId, services.now());
  revalidatePath(pathOf(sequenceId));
  return retried ? { ok: true, said: "Il repart au prochain envoi." } : { ok: false, error: "Ce message n’est plus à relancer." };
}

export async function removePersonAction(sequenceId: string, enrollmentId: string): Promise<void> {
  const seat = await currentSeat();
  await removeFromSequence(appServices().db, seat.workspaceId, enrollmentId);
  revalidatePath(pathOf(sequenceId));
}
