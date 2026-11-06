import type { InboundRequest, Signal } from "@/application/ports";
import { ProviderError } from "../http";
import { e164 } from "../phone";
import { forgedWebhook, hmac, sameSecret, unixDate } from "../webhooks";
import { withoutSecrets } from "../without-secrets";

/**
 * What Meta posts about a WhatsApp number: its handshake, and messages and statuses once signed.
 *
 * Handshake and signature: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint
 * Payloads: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components and, under
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/,
 * messages/text, messages/button, messages/interactive, messages/system, messages/status, user_preferences
 * Error codes: https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes
 */

const PROVIDER = "WhatsApp";
/** "This recipient has chosen to stop receiving marketing messages on WhatsApp from your business." */
const STOPPED_MARKETING = 131050;
const STOP_WORDS = new Set(["STOP", "ARRET"]);
/** As much of a reply as a signal keeps: its first lines. */
const DETAIL_LENGTH = 500;

interface IncomingMessage {
  id: string;
  /** Omitted when the person uses a username and their number can't be shared. */
  from?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  button?: { text?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
}

interface MessageStatus {
  id: string;
  status?: string;
  timestamp?: string;
  recipient_id?: string;
  errors?: { code?: number; title?: string; message?: string }[];
}

interface UserPreference {
  wa_id?: string;
  value?: string;
  timestamp?: number;
}

interface ChangeValue {
  metadata?: { phone_number_id?: string };
  messages?: IncomingMessage[];
  statuses?: MessageStatus[];
  user_preferences?: UserPreference[];
}

export interface WhatsAppPayload {
  entry?: { changes?: { value?: ChangeValue }[] }[];
}

/** Meta's verification: the member uses the connection's hook token as the verify token. Throws when it doesn't match. */
export function handshakeReply(request: InboundRequest, hookUrl: string): Response {
  const query = new URL(request.url).searchParams;
  const expected = new URL(hookUrl).searchParams.get("token");
  const given = query.get("hub.verify_token");
  if (query.get("hub.mode") !== "subscribe" || !expected || !given || !sameSecret(given, expected)) throw new ProviderError(PROVIDER, 403, "Le jeton de vérification de WhatsApp ne correspond pas.");
  return new Response(query.get("hub.challenge") ?? "", { status: 200, headers: { "content-type": "text/plain" } });
}

/** Throws unless the raw body carries Meta's signature, made with the app's secret. */
export function assertSignedByMeta(request: InboundRequest, appSecret: string): void {
  const given = request.headers.get("x-hub-signature-256") ?? "";
  if (!sameSecret(given, `sha256=${hmac("sha256", appSecret, request.body, "hex")}`)) throw forgedWebhook(PROVIDER);
}

const textOf = (message: IncomingMessage) => message.text?.body ?? message.button?.text ?? message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title;

/** Whether the whole message is a way to stop, whatever its case, accents and punctuation: "Arrêt !". */
function isStop(text: string): boolean {
  return STOP_WORDS.has(
    text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .replace(/[^A-Z]/g, ""),
  );
}

function incomingSignal(message: IncomingMessage, now: Date): Signal | null {
  // A notice that the person changed number, not something they wrote.
  if (message.type === "system") return null;
  const text = textOf(message);
  return {
    type: text && isStop(text) ? "opted_out" : "replied",
    channel: "whatsapp",
    externalId: message.id,
    address: e164(message.from),
    at: unixDate(message.timestamp, now),
    detail: text?.slice(0, DETAIL_LENGTH),
  };
}

function reasonOf(error: { message?: string; title?: string } | undefined): string | undefined {
  const reason = error?.message ?? error?.title;
  return reason ? withoutSecrets(reason) : undefined;
}

function statusSignal(status: MessageStatus, now: Date): Signal | null {
  if (status.status !== "delivered" && status.status !== "failed") return null;
  const error = status.errors?.[0];
  return {
    type: status.status === "delivered" ? "delivered" : error?.code === STOPPED_MARKETING ? "opted_out" : "failed",
    channel: "whatsapp",
    // A message's id: each of its statuses is an event of its own.
    externalId: `${status.id}:${status.status}`,
    address: e164(status.recipient_id),
    at: unixDate(status.timestamp, now),
    detail: reasonOf(error),
  };
}

function preferenceSignal(preference: UserPreference, now: Date): Signal | null {
  if (preference.value !== "stop") return null;
  return { type: "opted_out", channel: "whatsapp", externalId: `preferences:${preference.wa_id}:${preference.timestamp}`, address: e164(preference.wa_id), at: unixDate(preference.timestamp, now) };
}

/**
 * The signals in Meta's post about this number. A business account can hold several numbers, and
 * its webhook carries them all. Meta doesn't report that someone blocked the business: stopping
 * marketing messages is the only refusal it tells.
 */
export function signalsIn(payload: WhatsAppPayload, phoneNumberId: string, now: Date): Signal[] {
  const values = (payload.entry ?? []).flatMap((entry) => entry.changes ?? []).flatMap((change) => change.value ?? []);
  return values
    .filter((value) => !value.metadata?.phone_number_id || value.metadata.phone_number_id === phoneNumberId)
    .flatMap((value) => [
      ...(value.messages ?? []).map((message) => incomingSignal(message, now)),
      ...(value.statuses ?? []).map((status) => statusSignal(status, now)),
      ...(value.user_preferences ?? []).map((preference) => preferenceSignal(preference, now)),
    ])
    .filter((signal): signal is Signal => signal !== null);
}
