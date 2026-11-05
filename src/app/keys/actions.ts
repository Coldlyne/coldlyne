"use server";

import { revalidatePath } from "next/cache";
import { createApiKey, revokeApiKey } from "@/application/api-keys";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";

/** A new key, shown once: only its hash is kept. */
export async function createKeyAction(_previous: { key?: string }, formData: FormData): Promise<{ key?: string }> {
  const seat = await currentSeat();
  const { key } = await createApiKey(db(), seat.workspaceId, seat.userId, String(formData.get("name") ?? ""));
  revalidatePath("/keys");
  return { key };
}

export async function revokeKeyAction(id: string): Promise<void> {
  const seat = await currentSeat();
  await revokeApiKey(db(), seat.workspaceId, id);
  revalidatePath("/keys");
}
