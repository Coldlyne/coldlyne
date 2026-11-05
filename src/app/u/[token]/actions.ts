"use server";

import { redirect } from "next/navigation";
import { unsubscribe } from "@/application/unsubscribe";
import { appServices } from "@/infrastructure/services";

export async function confirmUnsubscribe(token: string): Promise<void> {
  await unsubscribe(appServices(), token);
  redirect(`/u/${token}?done=1`);
}
