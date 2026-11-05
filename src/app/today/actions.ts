"use server";

import { revalidatePath } from "next/cache";
import type { Tried } from "@/application/connection-use";
import { completeTask, leaveVoicemail, placeTaskCall, TASK_OUTCOMES, type TaskOutcome } from "@/application/tasks";
import { currentSeat } from "@/infrastructure/auth/session";
import { appServices } from "@/infrastructure/services";

export async function completeTaskAction(messageId: string, _previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const outcome = String(form.get("outcome") ?? "done") as TaskOutcome;
  if (!TASK_OUTCOMES.includes(outcome)) return { ok: false, error: "Cette issue n’existe pas." };
  const done = await completeTask(appServices(), seat.workspaceId, seat.userId, messageId, outcome, String(form.get("summary") ?? ""));
  revalidatePath("/today");
  return done;
}

export async function callAction(messageId: string): Promise<Tried> {
  const seat = await currentSeat();
  const called = await placeTaskCall(appServices(), seat.workspaceId, seat.userId, messageId);
  revalidatePath("/today");
  return called;
}

export async function voicemailAction(messageId: string): Promise<Tried> {
  const seat = await currentSeat();
  return leaveVoicemail(appServices(), seat.workspaceId, messageId);
}
