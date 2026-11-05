import type { Check, ConnectorClient, WebhookReader, WhatsAppSender } from "@/application/ports";
import type { AdapterContext } from "../adapter";
import { checked } from "../checked";
import { bearerJson, requestJson } from "../http";
import { parseWebhook } from "../webhooks";
import { assertSignedByMeta, handshakeReply, signalsIn, type WhatsAppPayload } from "./webhook";

/**
 * Meta's WhatsApp Cloud API: approved templates only, and to people who agreed (Meta's rule, which
 * the use case keeps: the adapter sends what it is asked).
 *
 * Sending: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages.md,
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview
 * The number: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/phone-numbers
 * Versions: https://developers.facebook.com/docs/graph-api/changelog/
 */

/** The current version of the Graph API, available until Meta sets a date for it. */
const GRAPH_VERSION = "v26.0";
const PROVIDER = "WhatsApp";

const QUALITY: Readonly<Record<string, string>> = { GREEN: "élevée", YELLOW: "moyenne", RED: "faible" };

async function checkNumber(context: AdapterContext, numberUrl: string): Promise<Check> {
  const number = await requestJson<{ display_phone_number: string; verified_name: string; quality_rating?: string }>(context.fetch, PROVIDER, numberUrl, { headers: bearerJson(context.fields.accessToken) });
  const quality = QUALITY[number.quality_rating ?? ""] ?? "inconnue";
  return { ok: true, label: number.display_phone_number, detail: `${number.verified_name}, qualité ${quality}` };
}

export function whatsappCloudAdapter(context: AdapterContext): ConnectorClient & WhatsAppSender & WebhookReader {
  const { accessToken, appSecret, phoneNumberId } = context.fields;
  const numberUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}`;
  return {
    check: () => checked(PROVIDER, () => checkNumber(context, numberUrl)),
    sendTemplate: async ({ to, template, language, parameters }) => {
      const components = parameters.length ? [{ type: "body", parameters: parameters.map((text) => ({ type: "text", text })) }] : undefined;
      const body = { messaging_product: "whatsapp", recipient_type: "individual", to, type: "template", template: { name: template, language: { code: language }, components } };
      const sent = await requestJson<{ messages: { id: string }[] }>(context.fetch, PROVIDER, `${numberUrl}/messages`, { method: "POST", headers: bearerJson(accessToken), body: JSON.stringify(body) });
      return { externalId: sent.messages[0].id };
    },
    readWebhook: async (request) => {
      if (request.method === "GET") return { signals: [], reply: handshakeReply(request, context.hookUrl) };
      assertSignedByMeta(request, appSecret);
      return { signals: signalsIn(parseWebhook<WhatsAppPayload>(PROVIDER, request.body), phoneNumberId, context.now()) };
    },
  };
}
