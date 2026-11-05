import type { Check, ConnectorClient, Dialer, Signal, SignalType, WebhookReader } from "@/application/ports";
import type { AdapterContext } from "../adapter";
import { checked } from "../checked";
import { basic, ProviderError, requestJson } from "../http";
import { e164 } from "../phone";
import { callSignal } from "./calls";
import { assertFromTwilio } from "./twilio-signature";

/**
 * Twilio Programmable Voice, by plain REST: Coldlyne rings the member from the caller number, and
 * once they pick up, TwiML dials the prospect. No speech is ever synthesized on these calls.
 *
 * Calls: https://www.twilio.com/docs/voice/api/call-resource
 * Dialing: https://www.twilio.com/docs/voice/twiml/dial, https://www.twilio.com/docs/voice/twiml/number
 * Callbacks: https://www.twilio.com/docs/voice/twiml, https://www.twilio.com/docs/usage/security
 * Account and numbers: https://www.twilio.com/docs/iam/api/account,
 * https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource,
 * https://www.twilio.com/docs/voice/api/outgoing-caller-ids
 */

const API = "https://api.twilio.com/2010-04-01";
const PROVIDER = "Twilio";
/** Rung briefly: if the member's own voicemail picked up, Twilio would take it for the member and dial the prospect. */
const MEMBER_RING_SECONDS = 25;
/** Long enough for the prospect's voicemail to pick up, where the member can leave the message. */
const PROSPECT_RING_SECONDS = 45;
/** Marks the callback of a leg that was redirected to the recording: Twilio can't tell a voicemail from a person. */
const OUTCOME_PARAM = "outcome";
const VOICEMAIL_LEFT: SignalType = "voicemail_left";

/** Twilio's REST API for one account: form-encoded in, JSON back. */
function twilioApi(context: AdapterContext) {
  const { accountSid, authToken } = context.fields;
  const account = `${API}/Accounts/${accountSid}`;
  const headers = { authorization: basic(accountSid, authToken), accept: "application/json" };
  return {
    get: <T>(path: string) => requestJson<T>(context.fetch, PROVIDER, `${account}${path}`, { headers }),
    post: <T>(path: string, form: Record<string, string>) =>
      requestJson<T>(context.fetch, PROVIDER, `${account}${path}`, { method: "POST", headers: { ...headers, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() }),
  };
}

type TwilioApi = ReturnType<typeof twilioApi>;

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** What the member's leg does once they pick up: dial the prospect, whose leg reports its outcome. */
function dialProspect(prospectPhone: string, callerId: string, hookUrl: string): string {
  const number = `<Number statusCallback="${xml(hookUrl)}" statusCallbackEvent="completed" statusCallbackMethod="POST">${xml(prospectPhone)}</Number>`;
  return `<Response><Dial callerId="${xml(callerId)}" timeout="${PROSPECT_RING_SECONDS}">${number}</Dial></Response>`;
}

/** Whether Twilio lets the account call from this number: one of its own, or one it verified. */
async function ownsNumber(api: TwilioApi, number: string): Promise<boolean> {
  const query = new URLSearchParams({ PhoneNumber: number });
  const own = await api.get<{ incoming_phone_numbers: { phone_number: string }[] }>(`/IncomingPhoneNumbers.json?${query}`);
  if (own.incoming_phone_numbers.some((found) => found.phone_number === number)) return true;
  const verified = await api.get<{ outgoing_caller_ids: { phone_number: string }[] }>(`/OutgoingCallerIds.json?${query}`);
  return verified.outgoing_caller_ids.some((found) => found.phone_number === number);
}

async function checkAccount(api: TwilioApi, callerId: string): Promise<Check> {
  const account = await api.get<{ friendly_name: string; status: string }>(".json");
  if (account.status !== "active") return { ok: false, detail: `Ce compte Twilio est ${account.status === "suspended" ? "suspendu" : "fermé"}.` };
  const caller = e164(callerId);
  if (!caller) return { ok: false, detail: `Le numéro appelant ${callerId} n’est pas au format international (+33…).` };
  if (!(await ownsNumber(api, caller))) return { ok: false, detail: `Le numéro appelant ${caller} n’est ni un numéro de ce compte Twilio, ni un numéro qu’il a vérifié.` };
  return { ok: true, label: account.friendly_name, detail: `Numéro appelant\u00A0: ${caller}` };
}

/** Redirects the prospect's leg of the member's call to the recording; the member's leg ends with it. */
async function playRecording(api: TwilioApi, memberCallSid: string, recordingUrl: string, hookUrl: string): Promise<void> {
  const query = new URLSearchParams({ ParentCallSid: memberCallSid, Status: "in-progress" });
  const { calls } = await api.get<{ calls: { sid: string }[] }>(`/Calls.json?${query}`);
  if (!calls.length) throw new ProviderError(PROVIDER, 404, "Aucun appel en cours vers le prospect\u00A0: le message n’a pas été laissé.");
  const callback = new URL(hookUrl);
  callback.searchParams.set(OUTCOME_PARAM, VOICEMAIL_LEFT);
  await api.post(`/Calls/${calls[0].sid}.json`, { Twiml: `<Response><Play>${xml(recordingUrl)}</Play><Hangup/></Response>`, StatusCallback: callback.toString(), StatusCallbackMethod: "POST" });
}

const OUTCOMES: Readonly<Record<string, SignalType>> = { completed: "answered", busy: "no_answer", "no-answer": "no_answer", canceled: "no_answer", failed: "failed" };

/** The prospect's leg when it ended. The member's leg has no parent, and says nothing about the prospect. */
function prospectOutcome(params: URLSearchParams, requestUrl: string, now: Date): Signal[] {
  const callSid = params.get("CallSid");
  const outcome = OUTCOMES[params.get("CallStatus") ?? ""];
  if (!callSid || !params.get("ParentCallSid") || !outcome) return [];
  const voicemail = outcome === "answered" && new URL(requestUrl).searchParams.get(OUTCOME_PARAM) === VOICEMAIL_LEFT;
  const at = new Date(params.get("Timestamp") ?? "");
  return [
    callSignal({
      type: voicemail ? VOICEMAIL_LEFT : outcome,
      // Its own id: should Twilio also send the leg's first callback, the message left isn't lost to it.
      externalId: voicemail ? `${callSid}:voicemail` : callSid,
      address: e164(params.get("To")),
      at: Number.isNaN(at.getTime()) ? now : at,
      seconds: Number(params.get("CallDuration")),
    }),
  ];
}

export function twilioAdapter(context: AdapterContext): ConnectorClient & Required<Dialer> & WebhookReader {
  const { authToken, callerId } = context.fields;
  const api = twilioApi(context);
  return {
    check: () => checked(PROVIDER, () => checkAccount(api, callerId)),
    placeCall: async ({ memberPhone, prospectPhone }) => {
      const from = e164(callerId) ?? callerId;
      const call = await api.post<{ sid: string }>("/Calls.json", { To: memberPhone, From: from, Timeout: String(MEMBER_RING_SECONDS), Twiml: dialProspect(prospectPhone, from, context.hookUrl) });
      return { externalId: call.sid };
    },
    dropVoicemail: (callId, recordingUrl) => playRecording(api, callId, recordingUrl, context.hookUrl),
    readWebhook: async (request) => {
      const params = new URLSearchParams(request.body);
      assertFromTwilio(request, params, authToken);
      return { signals: prospectOutcome(params, request.url, context.now()) };
    },
  };
}
