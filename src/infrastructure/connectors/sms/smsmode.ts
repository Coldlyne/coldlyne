import type { Signal } from "@/application/ports";
import type { Adapter } from "../adapter";
import { balanceOf, checked } from "../checked";
import { requestJson } from "../http";
import { deliverySignal, optOutSignal, readDate, replySignal, webhookEvents } from "./signals";
import { fitsGsm7, withoutPlus, withoutStopMention } from "./text";

/**
 * smsmode. `body.stop` has it add its own STOP and short code at the end of the text, mandatory on
 * a marketing channel with a personal sender. Each message names Coldlyne's address for its
 * reports and replies, so nothing has to be set in smsmode's console. It signs nothing it posts,
 * so the route's URL token is the only check.
 *
 * Docs: https://dev.smsmode.com/sms/v1/ (https://dev.smsmode.com/sms/openapi/rest-sms.yml)
 *       https://dev.smsmode.com/commons/v1/ (https://dev.smsmode.com/commons/openapi/rest-commons.yml)
 *       https://support.smsmode.com/en/base-de-connaissance/r%C3%A9ception-webhooks-api-smsmode
 *       https://support.smsmode.com/fr/base-de-connaissance/la-mention-stop-sms-quest-ce-que-cest
 */

const API = "https://rest.smsmode.com";
const PROVIDER = "smsmode";

interface SmsmodeOrganisations {
  items?: { name?: string; balance?: { amount?: number; currency?: string; paymentType?: string } }[];
}

/** A delivery report (it has `status`) or a reply (`direction` MO, the prospect in `from`). */
interface SmsmodeEvent {
  messageId?: string;
  direction?: string;
  from?: string;
  sentDate?: string;
  body?: { text?: string };
  recipient?: { to?: string };
  status?: { value?: string; detail?: string; deliveryDate?: string };
}

export const smsmode: Adapter = (context) => {
  const headers = { "x-api-key": context.fields.apiKey, "content-type": "application/json", accept: "application/json" };
  return {
    check: () =>
      checked(PROVIDER, async () => {
        const { items } = await requestJson<SmsmodeOrganisations>(context.fetch, PROVIDER, `${API}/commons/v1/organisations`, { headers });
        const organisation = items?.[0];
        if (!organisation) return { ok: false, detail: "Aucune organisation sur ce compte smsmode." };
        return { ok: true, label: organisation.name, detail: balanceDetail(organisation.balance) };
      }),
    async sendSms({ to, text }) {
      const message = withoutStopMention(text);
      const body = {
        recipient: { to: withoutPlus(to) },
        from: context.fields.sender,
        body: { text: message, stop: true, encoding: fitsGsm7(message) ? "GSM7" : "UNICODE" },
        callbackUrlStatus: context.hookUrl,
        callbackUrlMo: context.hookUrl,
      };
      const sent = await requestJson<{ messageId: string }>(context.fetch, PROVIDER, `${API}/sms/v1/messages`, { method: "POST", headers, body: JSON.stringify(body) });
      return { externalId: sent.messageId };
    },
    async readWebhook(request) {
      const now = context.now();
      return { signals: webhookEvents<SmsmodeEvent>(PROVIDER, request.body).flatMap((event) => signalsOf(event, now)) };
    },
  };
};

/** A post-paid account's balance is what it owes, which says nothing about what it can still send. */
function balanceDetail(balance: NonNullable<SmsmodeOrganisations["items"]>[number]["balance"]): string {
  if (balance?.paymentType === "POST_PAY") return "Paiement après consommation";
  return balance?.amount === undefined ? "Compte actif" : balanceOf(balance.amount, balance.currency ?? "EUR");
}

function signalsOf(event: SmsmodeEvent, now: Date): Signal[] {
  if (event.status) return reportSignals(event, event.status, now);
  if (event.direction !== "MO" || !event.from || !event.messageId) return [];
  return [replySignal({ externalId: event.messageId, from: event.from, text: event.body?.text ?? "", at: readDate(event.sentDate, now) })];
}

/** A delivery report. Still on its way (SCHEDULED, ENROUTE), it says nothing yet. */
function reportSignals(event: SmsmodeEvent, status: NonNullable<SmsmodeEvent["status"]>, now: Date): Signal[] {
  const { messageId, recipient } = event;
  const to = recipient?.to;
  if (!messageId || !to) return [];
  const at = readDate(status.deliveryDate, now);
  // A STOP may stay at the shared short code; a later send refused as BLACKLISTED is how it shows.
  if (status.detail === "BLACKLISTED") return [optOutSignal({ from: to, at, detail: status.detail })];
  if (status.value === "DELIVERED") return [deliverySignal({ messageId, to, delivered: true, at })];
  if (status.value === "UNDELIVERABLE" || status.value === "UNDELIVERED") return [deliverySignal({ messageId, to, delivered: false, at, detail: status.detail ?? status.value })];
  return [];
}
