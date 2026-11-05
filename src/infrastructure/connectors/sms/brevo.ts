import type { Signal } from "@/application/ports";
import type { Adapter } from "../adapter";
import { checked } from "../checked";
import { requestJson } from "../http";
import { deliverySignal, optOutSignal, replySignal, webhookEvents } from "./signals";
import { creditsLeft, fitsGsm7, withoutPlus, withoutStopMention } from "./text";

/**
 * Brevo's SMS. Prospecting goes out as `marketing`, the type for commercial content. Brevo adds no
 * STOP of its own: the text must carry `STOP au [STOP_CODE]`, which it replaces with its number
 * and acts on. It doesn't sign what it posts, so the route's URL token is the only check.
 *
 * Docs: https://developers.brevo.com/reference/send-async-transactional-sms
 *       https://developers.brevo.com/docs/transactional-sms-endpoints
 *       https://developers.brevo.com/reference/get-account
 *       https://developers.brevo.com/docs/transactional-webhooks
 *       https://developers.brevo.com/docs/secured-webhooks
 *       https://help.brevo.com/hc/en-us/articles/11884482521234-Country-specific-guidelines-and-restrictions-for-SMS-messages
 */

const API = "https://api.brevo.com/v3";
const PROVIDER = "Brevo";
const STOP_CLAUSE = "STOP au [STOP_CODE]";

interface BrevoAccount {
  email?: string;
  companyName?: string;
  plan?: { type?: string; credits?: number }[];
}

/** One of Brevo's SMS events. On a reply too, the prospect's number is `to`. */
interface BrevoEvent {
  msg_status?: string;
  to?: string;
  reply?: string;
  description?: string;
  messageId?: number;
  ts_event?: number;
}

export const brevoSms: Adapter = (context) => {
  const headers = { "api-key": context.fields.apiKey, "content-type": "application/json", accept: "application/json" };
  return {
    check: () =>
      checked(PROVIDER, async () => {
        const account = await requestJson<BrevoAccount>(context.fetch, PROVIDER, `${API}/account`, { headers });
        const credits = account.plan?.find((plan) => plan.type === "sms")?.credits ?? 0;
        return { ok: true, label: account.companyName || account.email, detail: creditsLeft(credits) };
      }),
    async sendSms({ to, text }) {
      const content = `${withoutStopMention(text)} ${STOP_CLAUSE}`;
      const body = { sender: context.fields.sender, recipient: withoutPlus(to), content, type: "marketing", webUrl: context.hookUrl, unicodeEnabled: !fitsGsm7(content) };
      const sent = await requestJson<{ messageId: number }>(context.fetch, PROVIDER, `${API}/transactionalSMS/send`, { method: "POST", headers, body: JSON.stringify(body) });
      return { externalId: String(sent.messageId) };
    },
    async readWebhook(request) {
      const now = context.now();
      return { signals: webhookEvents<BrevoEvent>(PROVIDER, request.body).flatMap((event) => signalsOf(event, now)) };
    },
  };
};

/** What an event means for a prospect; `sent` and `accepted` say nothing yet, and are left out. */
function signalsOf(event: BrevoEvent, now: Date): Signal[] {
  const { to, msg_status: status, description: detail } = event;
  if (!to) return [];
  // `date` has no zone (Paris time), so only `ts_event`, in UTC, is read; some events have neither.
  const at = event.ts_event ? new Date(event.ts_event * 1000) : now;
  // A skipped message has `messageId` 0, and `id` is the webhook's, the same on every event.
  const messageId = event.messageId ? String(event.messageId) : `${to}:${at.getTime()}`;
  switch (status) {
    case "replied":
      return [replySignal({ externalId: `${messageId}:${at.getTime()}`, from: to, text: event.reply ?? "", at })];
    // `bl`: Brevo refused the send because the number is on its blocklist, as a STOP puts it.
    case "unsubscribed":
    case "bl":
      return [optOutSignal({ from: to, at, detail })];
    case "delivered":
      return [deliverySignal({ messageId, to, delivered: true, at })];
    case "soft_bounce":
    case "hard_bounce":
    case "rej":
    case "skip":
      return [deliverySignal({ messageId, to, delivered: false, at, detail: detail ?? status })];
    default:
      return [];
  }
}
