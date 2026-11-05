"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { startOAuthConnection } from "@/application/connection-grants";
import { factsOf, readNow, sendTestAlert, tryCheck, tryTestEmail, type Tried } from "@/application/connection-use";
import { connectWithFields, disconnect } from "@/application/connections";
import { resumeMailbox } from "@/application/scheduler";
import { currentSeat } from "@/infrastructure/auth/session";
import { appServices } from "@/infrastructure/services";

export interface ConnectState {
  error?: string;
  connected?: string;
}

/** Connects a service from what the member typed; the service answers before anything is saved. */
export async function connectAction(kind: string, _previous: ConnectState, formData: FormData): Promise<ConnectState> {
  const seat = await currentSeat();
  const result = await connectWithFields(appServices(), seat.workspaceId, seat.userId, kind, Object.fromEntries(formData));
  if (!result.ok) return { error: result.error };
  revalidatePath(`/connections/${kind}`);
  return { connected: result.connection.label };
}

/** Sends the member to sign in to the provider. */
export async function signInToProviderAction(kind: string): Promise<void> {
  const seat = await currentSeat();
  const result = await startOAuthConnection(appServices(), seat.workspaceId, seat.userId, kind);
  redirect(result.ok ? result.url : `/connections/${kind}?error=${encodeURIComponent(result.error)}`);
}

/** What each button of a connection does: the page shows the answer, and the connection's state as it now stands. */
async function tryOn(kind: string, attempt: (workspaceId: string, userId: string) => Promise<Tried>): Promise<Tried> {
  const seat = await currentSeat();
  const tried = await attempt(seat.workspaceId, seat.userId);
  revalidatePath(`/connections/${kind}`);
  return tried;
}

export async function checkAction(kind: string, connectionId: string): Promise<Tried> {
  return tryOn(kind, (workspaceId) => tryCheck(appServices(), workspaceId, connectionId));
}

export async function testEmailAction(kind: string, connectionId: string): Promise<Tried> {
  return tryOn(kind, (workspaceId, userId) => tryTestEmail(appServices(), workspaceId, userId, connectionId));
}

export async function testAlertAction(kind: string, connectionId: string): Promise<Tried> {
  return tryOn(kind, (workspaceId) => sendTestAlert(appServices(), workspaceId, connectionId));
}

export async function readNowAction(kind: string, connectionId: string): Promise<Tried> {
  return tryOn(kind, (workspaceId) => readNow(appServices(), workspaceId, connectionId));
}

export async function disconnectAction(kind: string, connectionId: string): Promise<void> {
  const seat = await currentSeat();
  await disconnect(appServices(), seat.workspaceId, connectionId);
  revalidatePath(`/connections/${kind}`);
}

/** A member decides a paused mailbox may send again. */
export async function resumeAction(kind: string, connectionId: string): Promise<Tried> {
  const seat = await currentSeat();
  const resumed = await resumeMailbox(appServices().db, seat.workspaceId, connectionId);
  revalidatePath(`/connections/${kind}`);
  return resumed ? { ok: true, said: "Cette boîte peut de nouveau envoyer." } : { ok: false, error: "Cette connexion n’existe plus." };
}

export type FactsState = Awaited<ReturnType<typeof factsOf>> | null;

/** What a connected source knows about the company a member asks for. */
export async function factsAction(connectionId: string, _previous: FactsState, formData: FormData): Promise<FactsState> {
  const seat = await currentSeat();
  return factsOf(appServices(), seat.workspaceId, connectionId, String(formData.get("siren") ?? "").replace(/\s/g, ""));
}
