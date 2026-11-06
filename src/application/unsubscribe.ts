import { createHmac } from "node:crypto";
import { sameSecret } from "@/infrastructure/crypto/secrets";
import { withWorkspace } from "@/infrastructure/db/tenant";
import type { Env } from "@/infrastructure/env";
import { addToSuppressionList } from "./enrollments";
import type { Services } from "./services";
import { recordSignals } from "./signals";
import { settingsOf } from "./workspace-settings";

/**
 * The way out every message carries: a link that needs no account and no lookup table, signed so
 * that nobody can unsubscribe someone else by guessing. It keeps working for as long as the
 * instance's secrets key does, which is what the law asks of it.
 */

type UnsubscribeSettings = Pick<Env, "BETTER_AUTH_URL" | "COLDLYNE_SECRETS_KEY">;

const signature = (payload: string, key: string | undefined) => createHmac("sha256", key ?? "").update(`unsubscribe:${payload}`).digest("base64url");

export function unsubscribeToken(settings: UnsubscribeSettings, workspaceId: string, address: string): string {
  const payload = Buffer.from(`${workspaceId}|${address.trim().toLowerCase()}`).toString("base64url");
  return `${payload}.${signature(payload, settings.COLDLYNE_SECRETS_KEY)}`;
}

export const unsubscribeUrl = (settings: UnsubscribeSettings, workspaceId: string, address: string) => new URL(`/u/${unsubscribeToken(settings, workspaceId, address)}`, settings.BETTER_AUTH_URL).toString();

/** Who a link is for, when its signature holds. */
export function readUnsubscribeToken(settings: UnsubscribeSettings, token: string): { workspaceId: string; address: string } | null {
  const [payload, given] = token.split(".");
  if (!payload || !given || !sameSecret(given, signature(payload, settings.COLDLYNE_SECRETS_KEY))) return null;
  const [workspaceId, address] = Buffer.from(payload, "base64url").toString("utf8").split("|");
  return workspaceId && address ? { workspaceId, address } : null;
}

/** What the page says the link is for: the sender's name, never anything about the person. */
export async function unsubscribeSubject(services: Services, token: string): Promise<{ sender: string; address: string } | null> {
  const read = readUnsubscribeToken(services.settings, token);
  if (!read) return null;
  const { senderName } = await settingsOf(services.db, read.workspaceId);
  return { sender: senderName ?? "cet expéditeur", address: read.address };
}

/**
 * Honours the request at once: on the suppression list for every channel, and every sequence that
 * was writing to them stops, along with the rest of their company. Asking twice changes nothing.
 */
export async function unsubscribe(services: Services, token: string): Promise<boolean> {
  const read = readUnsubscribeToken(services.settings, token);
  if (!read) return false;
  const { workspaceId, address } = read;
  await withWorkspace(services.db, workspaceId, (tx) => addToSuppressionList(tx, [{ value: address, reason: "opted_out" }]));
  await recordSignals(services.db, workspaceId, null, [{ type: "opted_out", channel: address.includes("@") ? "email" : "sms", externalId: `unsubscribe:${address}:${services.now().toISOString()}`, address, at: services.now(), detail: "Désinscription par le lien du message" }]);
  return true;
}
