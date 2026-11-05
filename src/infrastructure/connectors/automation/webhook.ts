import { createHmac } from "node:crypto";
import type { Check, Notification } from "@/application/ports";
import { sameSecret } from "@/infrastructure/crypto/secrets";
import type { Adapter, AdapterContext } from "../adapter";
import { isInternalHost } from "../hosts";
import { ProviderError, requestText } from "../http";

/**
 * An outgoing webhook, for n8n, Make or Zapier: each notification POSTed as JSON to the address
 * the member gave, signed the way Stripe signs its webhooks, so the receiver can tell Coldlyne's
 * calls from anyone else's and refuse a replayed one.
 *
 * Coldlyne's own format, documented for receivers at https://coldlyne.com/docs/webhooks.
 *   Body: { "event", "title", "text", "url", "at" }.
 *   Header: Coldlyne-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">.
 */

const PROVIDER = "Le webhook";
const SIGNATURE_HEADER = "Coldlyne-Signature";

/** The signing secret: the `token` of the connection's own address, which its page shows the member. */
export function signingSecretOf(hookUrl: string): string {
  const token = new URL(hookUrl).searchParams.get("token");
  if (!token) throw new Error("The connection's address carries no token to sign webhooks with.");
  return token;
}

/** The address the member gave, once it is known to be public and encrypted. */
function receiverOf(address: string): string {
  const url = URL.canParse(address) ? new URL(address) : null;
  if (url?.protocol !== "https:" || isInternalHost(url.hostname)) throw new ProviderError(PROVIDER, 400, "L’adresse du webhook doit être une adresse https publique.");
  return address;
}

const hmac = (secret: string, timestamp: number, body: string) => createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

/** The signature header's value for this body, at this time. */
export function signColdlyne(body: string, secret: string, now: Date): string {
  const timestamp = Math.floor(now.getTime() / 1000);
  return `t=${timestamp},v1=${hmac(secret, timestamp, body)}`;
}

/**
 * Whether a body really comes from Coldlyne: signed with this secret, less than `toleranceSeconds`
 * ago (so a captured call can't be replayed later). Pure, for receivers to copy.
 */
export function verifyColdlyneSignature(body: string, header: string, secret: string, now: Date, toleranceSeconds = 300): boolean {
  const parts = header.split(",").map((part) => part.trim().split("="));
  const timestamp = Number(parts.find(([key]) => key === "t")?.[1]);
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value ?? "");
  if (!Number.isInteger(timestamp) || !signatures.length) return false;
  if (Math.abs(now.getTime() / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = hmac(secret, timestamp, body);
  return signatures.some((signature) => sameSecret(signature, expected));
}

/** Posts one notification, signed. A redirect isn't followed: it could lead anywhere, so it is reported as an answer. */
async function post(context: AdapterContext, notification: Notification): Promise<void> {
  const receiver = receiverOf(context.fields.url);
  const now = context.now();
  const { event, title, text, url } = notification;
  const body = JSON.stringify({ event, title, text, url: url ?? null, at: now.toISOString() });
  const headers = { "content-type": "application/json", [SIGNATURE_HEADER]: signColdlyne(body, signingSecretOf(context.hookUrl), now) };
  await requestText(context.fetch, PROVIDER, receiver, { method: "POST", headers, body, redirect: "manual" });
}

const TEST: Notification = { event: "test", title: "Test de Coldlyne", text: "Si vous lisez ceci, le webhook reçoit bien les événements de Coldlyne." };

/** Sends a `test` event: the only way to know the receiver answers. */
async function check(context: AdapterContext): Promise<Check> {
  try {
    await post(context, TEST);
    return { ok: true, detail: "événement de test reçu", label: new URL(context.fields.url).host };
  } catch (error) {
    if (error instanceof ProviderError) return { ok: false, detail: error.message };
    throw error;
  }
}

export const webhook: Adapter = (context) => ({
  check: () => check(context),
  notify: (notification) => post(context, notification),
});
