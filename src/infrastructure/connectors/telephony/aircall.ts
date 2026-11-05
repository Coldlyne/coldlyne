import type { Check, ConnectorClient, Dialer, Signal, WebhookReader } from "@/application/ports";
import type { AdapterContext } from "../adapter";
import { checked } from "../checked";
import { basic, ProviderError, requestJson } from "../http";
import { e164 } from "../phone";
import { forgedWebhook, parseWebhook, sameSecret, unixDate } from "../webhooks";
import { callback, callSignal, numbersDetail } from "./calls";

/**
 * Aircall: the call starts in the member's Aircall app, on a line they are assigned. Coldlyne can't
 * play a recording on it, so there is no voicemail drop here.
 *
 * Authentication, users, numbers, company, webhooks, calls: https://developers.aircall.io/api-references
 * Starting a call: https://developer.aircall.io/docs/outbound-calls.md
 * Events: https://developer.aircall.io/docs/webhooks-overview.md, https://developer.aircall.io/docs/setup-webhooks.md,
 * https://developer.aircall.io/docs/work-with-call-data.md
 */

const API = "https://api.aircall.io/v1";
const PROVIDER = "Aircall";
/** The most its lists return a page. */
const PAGE_SIZE = 50;

interface AircallNumber {
  id: number;
  digits: string;
  /** Only when retrieving one number, not in the list. */
  users?: { id: number }[];
}

interface AircallEvent {
  event?: string;
  token?: string;
  timestamp?: number;
  data?: { id?: number | string; direction?: string; raw_digits?: string; answered_at?: number | null; ended_at?: number | null };
}

/** Aircall's REST API for one company: JSON both ways, its lists read to the end. */
function aircallApi(context: AdapterContext) {
  const headers = { authorization: basic(context.fields.apiId, context.fields.apiToken), accept: "application/json" };
  const get = <T>(path: string) => requestJson<T>(context.fetch, PROVIDER, `${API}${path}`, { headers });
  return {
    get,
    post: (path: string, body: unknown) => requestJson<void>(context.fetch, PROVIDER, `${API}${path}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) }),
    all: async <T>(path: string, key: string): Promise<T[]> => {
      const items: T[] = [];
      for (let page = 1; ; page++) {
        const body = await get<Record<string, unknown>>(`${path}?per_page=${PAGE_SIZE}&page=${page}`);
        items.push(...((body[key] as T[] | undefined) ?? []));
        if (!(body.meta as { next_page_link?: string | null } | undefined)?.next_page_link) return items;
      }
    },
  };
}

type AircallApi = ReturnType<typeof aircallApi>;

async function checkCompany(api: AircallApi): Promise<Check> {
  const { company } = await api.get<{ company: { name: string } }>("/company");
  const numbers = await api.all<AircallNumber>("/numbers", "numbers");
  if (!numbers.length) return { ok: false, detail: `Aucun numéro sur le compte Aircall ${company.name}.` };
  return { ok: true, label: company.name, detail: numbersDetail(numbers.map((number) => number.digits)) };
}

/**
 * The Aircall line whose number is the member's, and the one person assigned to it. The port only
 * gives a phone number, which can't tell the people sharing a line apart: the call would ring
 * in someone else's app, so that is refused.
 */
async function memberLine(api: AircallApi, memberPhone: string): Promise<{ numberId: number; userId: number }> {
  const numbers = await api.all<AircallNumber>("/numbers", "numbers");
  const line = numbers.find((number) => e164(number.digits) === e164(memberPhone));
  if (!line) throw new ProviderError(PROVIDER, 404, `Le numéro ${memberPhone} n’est pas une ligne de ce compte Aircall.`);
  const { number } = await api.get<{ number: AircallNumber }>(`/numbers/${line.id}`);
  const users = number.users ?? [];
  if (!users.length) throw new ProviderError(PROVIDER, 409, `La ligne Aircall ${line.digits} n’est attribuée à personne.`);
  if (users.length > 1) throw new ProviderError(PROVIDER, 409, `La ligne Aircall ${line.digits} est partagée\u00A0: Coldlyne ne peut pas savoir à qui lancer l’appel.`);
  return { numberId: line.id, userId: users[0].id };
}

async function startCall(api: AircallApi, line: { numberId: number; userId: number }, prospectPhone: string): Promise<void> {
  try {
    await api.post(`/users/${line.userId}/calls`, { number_id: line.numberId, to: prospectPhone });
  } catch (error) {
    if (error instanceof ProviderError && error.status === 405) throw new ProviderError(PROVIDER, 405, "La personne n’est pas disponible dans Aircall\u00A0: elle doit être connectée à l’application, hors appel.");
    throw error;
  }
}

/**
 * The prospect's outcome. `call.ended` is the complete record, about 30 seconds after the call: its
 * `answered_at` is null when the person called didn't pick up, and its `duration` counts the
 * ringing, so the time on the line is worked out. A call coming in is the person calling back.
 */
function prospectOutcome(event: AircallEvent, now: Date): Signal[] {
  const call = event.data;
  if (call?.id === undefined) return [];
  const at = unixDate(call.ended_at ?? event.timestamp, now);
  const shared = { externalId: String(call.id), address: e164(call.raw_digits), at };
  if (call.direction === "inbound") return event.event === "call.ended" ? [callback(shared)] : [];
  if (call.direction !== "outbound") return [];
  if (event.event === "call.voicemail_left") return [callSignal({ ...shared, type: "voicemail_left" })];
  if (event.event !== "call.ended") return [];
  if (!call.answered_at) return [callSignal({ ...shared, type: "no_answer" })];
  return [callSignal({ ...shared, type: "answered", seconds: call.ended_at ? call.ended_at - call.answered_at : null })];
}

/**
 * Aircall signs nothing: each event carries the token of the webhook it was sent for. Nothing for
 * the member to copy: the token is read from Aircall's webhook registered on this connection's address.
 */
async function assertSentByAircall(api: AircallApi, hookUrl: string, token: string | undefined): Promise<void> {
  const webhooks = await api.all<{ url: string; token: string }>("/webhooks", "webhooks");
  const registered = webhooks.find((webhook) => webhook.url === hookUrl);
  if (!registered || !sameSecret(token ?? "", registered.token)) throw forgedWebhook(PROVIDER);
}

export function aircallAdapter(context: AdapterContext): ConnectorClient & Dialer & WebhookReader {
  const api = aircallApi(context);
  return {
    check: () => checked(PROVIDER, () => checkCompany(api)),
    placeCall: async ({ memberPhone, prospectPhone, reference }) => {
      await startCall(api, await memberLine(api, memberPhone), prospectPhone);
      // Aircall answers 204, with no call id: the outcome is matched by the prospect's number.
      return { externalId: reference };
    },
    readWebhook: async (request) => {
      const event = parseWebhook<AircallEvent>(PROVIDER, request.body);
      const signals = prospectOutcome(event, context.now());
      // Asked only of events that say something, so the rest don't use up Aircall's rate limit.
      if (signals.length) await assertSentByAircall(api, context.hookUrl, event.token);
      return { signals };
    },
  };
}
