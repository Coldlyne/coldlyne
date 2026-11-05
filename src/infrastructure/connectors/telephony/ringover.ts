import type { Check, ConnectorClient, Dialer, Signal, WebhookReader } from "@/application/ports";
import type { AdapterContext } from "../adapter";
import { checked } from "../checked";
import { requestJson } from "../http";
import { e164 } from "../phone";
import { forgedWebhook, hmac, parseWebhook, sameSecret, unixDate } from "../webhooks";
import { callback, callSignal, numbersDetail } from "./calls";

/**
 * Ringover's callback: the member's device rings first, then the prospect. It can't play a recording
 * on the call, so there is no voicemail drop here.
 *
 * Its reference, https://developer.ringover.com/, is an app that couldn't be read when this was
 * written, so the requests stick to what other sources agree on:
 * Authentication and base URL: https://support.ringover.com/hc/en-us/articles/15206971712657-How-to-Create-a-Ringover-API-Key
 * Webhooks: https://support.ringover.com/hc/en-us/articles/15206913970577-How-to-use-our-webhooks,
 * Ringover's own samples at https://github.com/ringover/ringover-webhooks (events, payloads, signature)
 * POST /callback, /teams: third-party clients only, https://github.com/montpcdev/ringover-js,
 * https://github.com/Palpateam/n8n-nodes-ringover, https://github.com/dinistavares/go-ringover-api
 */

const API = "https://public-api.ringover.com/v2";
const PROVIDER = "Ringover";

interface RingoverEvent {
  event?: string;
  resource?: string;
  timestamp?: number;
  data?: {
    /** The event's UUID. `call_id` is a number too large to survive JSON.parse intact. */
    id?: string;
    direction?: string;
    is_internal?: boolean;
    from_number?: string;
    to_number?: string;
    hangup_time?: number;
    duration_in_seconds?: number | null;
  };
}

/** Ringover takes the key alone in the header, with no scheme before it. */
function ringoverApi(context: AdapterContext) {
  const headers = { authorization: context.fields.apiKey, "content-type": "application/json", accept: "application/json" };
  return {
    get: <T>(path: string) => requestJson<T>(context.fetch, PROVIDER, `${API}${path}`, { headers }),
    post: <T>(path: string, body: unknown) => requestJson<T>(context.fetch, PROVIDER, `${API}${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
  };
}

type RingoverApi = ReturnType<typeof ringoverApi>;

async function checkTeam(api: RingoverApi): Promise<Check> {
  const team = await api.get<{ name?: string; numbers?: { number?: number; format?: { e164?: string } }[] }>("/teams");
  const numbers = (team.numbers ?? []).map((found) => e164(found.format?.e164 ?? String(found.number))).filter((number) => number !== null);
  return { ok: true, label: team.name ?? PROVIDER, detail: numbers.length ? numbersDetail(numbers) : "Clé d’API acceptée." };
}

/** Ringover's numbers are integers: international, with no plus. */
const asInteger = (phone: string) => Number(phone.replace(/\D/g, ""));

/** The prospect's outcome, from the end of a call a member placed, or their calling back. Ringover tells no failed call apart. */
function prospectOutcome(event: RingoverEvent, now: Date): Signal[] {
  const call = event.data;
  if (event.resource !== "call" || !call?.id || call.is_internal) return [];
  const at = unixDate(call.hangup_time ?? event.timestamp, now);
  if (call.direction === "inbound") return event.event === "hangup" || event.event === "missed" ? [callback({ externalId: call.id, address: e164(call.from_number), at })] : [];
  if (call.direction !== "outbound") return [];
  const shared = { externalId: call.id, address: e164(call.to_number), at };
  const seconds = call.duration_in_seconds;
  switch (event.event) {
    case "hangup":
      return [callSignal({ ...shared, type: seconds ? "answered" : "no_answer", seconds })];
    case "missed":
      return [callSignal({ ...shared, type: "no_answer" })];
    case "voicemail":
      return [callSignal({ ...shared, type: "voicemail_left", seconds })];
    default:
      return [];
  }
}

/**
 * Ringover signs with a JWT in HS512, whose claims don't cover the body. The signature is worked out
 * with HS512 whatever the JWT's own header says, so a forged header can't weaken it.
 */
function assertSignedByRingover(token: string | null, secret: string, now: Date): void {
  const [header, claims, signature] = (token ?? "").split(".");
  if (!header || !claims || !signature || !sameSecret(signature, hmac("sha512", secret, `${header}.${claims}`, "base64url"))) throw forgedWebhook(PROVIDER);
  const { exp } = parseWebhook<{ exp?: number }>(PROVIDER, Buffer.from(claims, "base64url").toString());
  if (exp && exp * 1000 < now.getTime()) throw forgedWebhook(PROVIDER);
}

export function ringoverAdapter(context: AdapterContext): ConnectorClient & Dialer & WebhookReader {
  const api = ringoverApi(context);
  return {
    check: () => checked(PROVIDER, () => checkTeam(api)),
    placeCall: async ({ memberPhone, prospectPhone, reference }) => {
      const call = await api.post<{ call_id?: unknown } | undefined>("/callback", { from_number: asInteger(memberPhone), to_number: asInteger(prospectPhone) });
      return { externalId: typeof call?.call_id === "string" ? call.call_id : reference };
    },
    readWebhook: async (request) => {
      const { webhookSecret } = context.fields;
      // Without a saved secret, only the signed address of the connection vouches for the request.
      if (webhookSecret) assertSignedByRingover(request.headers.get("x-ringover-webhook-signature"), webhookSecret, context.now());
      return { signals: prospectOutcome(parseWebhook<RingoverEvent>(PROVIDER, request.body), context.now()) };
    },
  };
}
