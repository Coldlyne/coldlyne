"use server";

import { revalidatePath } from "next/cache";
import { createApiKey, revokeApiKey } from "@/application/api-keys";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";

export type NewKeyState = { key?: string; error?: string };

/** A new key, shown once: only its hash is kept. */
export async function createKeyAction(_previous: NewKeyState, formData: FormData): Promise<NewKeyState> {
  const seat = await currentSeat();
  const made = await createApiKey(db(), seat.workspaceId, seat.userId, String(formData.get("name") ?? ""));
  revalidatePath("/keys");
  return made.ok ? { key: made.key } : { error: made.error };
}

export async function revokeKeyAction(id: string): Promise<void> {
  const seat = await currentSeat();
  await revokeApiKey(db(), seat.workspaceId, seat.userId, id);
  revalidatePath("/keys");
}
