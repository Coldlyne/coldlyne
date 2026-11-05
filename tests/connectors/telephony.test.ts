import { describe, expect, it } from "vitest";
import type { InboundRequest } from "@/application/ports";
import { adapterOf } from "@/infrastructure/connectors";
import { aircallAdapter } from "@/infrastructure/connectors/telephony/aircall";
import { ringoverAdapter } from "@/infrastructure/connectors/telephony/ringover";
import { twilioAdapter } from "@/infrastructure/connectors/telephony/twilio";
import { assertFromTwilio, twilioSignature } from "@/infrastructure/connectors/telephony/twilio-signature";
import { adapterContext, fakeFetch, type FakeRoute } from "../support/fetch";

const HOOK = "https://coldlyne.test/api/hooks/00000000-0000-4000-8000-000000000000?token=hook-token";
const MEMBER = "+33612345678";
const PROSPECT = "+33698765432";

function inbound(body: string, headers: Record<string, string> = {}, url = HOOK): InboundRequest {
  return { method: "POST", url, headers: new Headers(headers), body };
}

describe("the telephony connectors", () => {
  it("are registered by kind", () => {
    expect(adapterOf("twilio")).toBe(twilioAdapter);
    expect(adapterOf("aircall")).toBe(aircallAdapter);
    expect(adapterOf("ringover")).toBe(ringoverAdapter);
  });
});

describe("Twilio", () => {
  const ACCOUNT = "https://api.twilio.com/2010-04-01/Accounts/AC123";
  const FIELDS = { accountSid: "AC123", authToken: "secret-token", callerId: "+33 1 23 45 67 89" };
  const twilio = (routes: FakeRoute[]) => {
    const { fetch, calls } = fakeFetch(routes);
    return { client: twilioAdapter(adapterContext(FIELDS, fetch)), calls };
  };

  describe("its check", () => {
    const account = { match: `GET ${ACCOUNT}.json`, json: { friendly_name: "Northwind", status: "active" } };
    const noOwnNumber = { match: `GET ${ACCOUNT}/IncomingPhoneNumbers.json`, json: { incoming_phone_numbers: [] } };

    it("names the account and its caller number, one of the account's own", async () => {
      const { client, calls } = twilio([account, { match: `GET ${ACCOUNT}/IncomingPhoneNumbers.json`, json: { incoming_phone_numbers: [{ phone_number: "+33123456789" }] } }]);

      expect(await client.check()).toEqual({ ok: true, label: "Northwind", detail: "Numéro appelant\u00A0: +33123456789" });
      expect(calls[0].headers.get("authorization")).toBe(`Basic ${Buffer.from("AC123:secret-token").toString("base64")}`);
      expect(new URL(calls[1].url).searchParams.get("PhoneNumber")).toBe("+33123456789");
    });

    it("accepts a caller number Twilio verified", async () => {
      const { client } = twilio([account, noOwnNumber, { match: `GET ${ACCOUNT}/OutgoingCallerIds.json`, json: { outgoing_caller_ids: [{ phone_number: "+33123456789" }] } }]);

      expect(await client.check()).toMatchObject({ ok: true, label: "Northwind" });
    });

    it("refuses a caller number that is neither", async () => {
      const { client } = twilio([account, noOwnNumber, { match: `GET ${ACCOUNT}/OutgoingCallerIds.json`, json: { outgoing_caller_ids: [] } }]);

      expect(await client.check()).toEqual({ ok: false, detail: "Le numéro appelant +33123456789 n’est ni un numéro de ce compte Twilio, ni un numéro qu’il a vérifié." });
    });

    it("refuses a caller number without its country", async () => {
      const { fetch } = fakeFetch([account]);
      const client = twilioAdapter(adapterContext({ ...FIELDS, callerId: "01 23 45 67 89" }, fetch));

      expect(await client.check()).toEqual({ ok: false, detail: "Le numéro appelant 01 23 45 67 89 n’est pas au format international (+33…)." });
    });

    it("says when the account is suspended", async () => {
      const { client } = twilio([{ match: `GET ${ACCOUNT}.json`, json: { friendly_name: "Northwind", status: "suspended" } }]);

      expect(await client.check()).toEqual({ ok: false, detail: "Ce compte Twilio est suspendu." });
    });

    it("says what Twilio refused", async () => {
      const { client } = twilio([{ match: `GET ${ACCOUNT}.json`, status: 401, json: { message: "Authenticate" } }]);

      expect(await client.check()).toEqual({ ok: false, detail: "Twilio a refusé les identifiants : Authenticate" });
    });

    it("says a broken network in the member's words, never as a raw error", async () => {
      const { client } = twilio([]);

      expect(await client.check()).toEqual({ ok: false, detail: "Twilio ne répond pas correctement pour le moment." });
    });
  });

  describe("placing a call", () => {
    it("rings the member from the caller number, then dials the prospect, whose leg reports to the hook", async () => {
      const { client, calls } = twilio([{ match: `POST ${ACCOUNT}/Calls.json`, json: { sid: "CAparent" } }]);

      const placed = await client.placeCall({ memberPhone: MEMBER, prospectPhone: PROSPECT, reference: "step-1" });

      expect(placed).toEqual({ externalId: "CAparent" });
      expect(calls[0].headers.get("content-type")).toBe("application/x-www-form-urlencoded");
      expect(calls[0].headers.get("authorization")).toBe(`Basic ${Buffer.from("AC123:secret-token").toString("base64")}`);
      expect(Object.fromEntries(new URLSearchParams(calls[0].body))).toEqual({
        To: MEMBER,
        From: "+33123456789",
        Timeout: "25",
        Twiml: `<Response><Dial callerId="+33123456789" timeout="45"><Number statusCallback="${HOOK}" statusCallbackEvent="completed" statusCallbackMethod="POST">${PROSPECT}</Number></Dial></Response>`,
      });
    });

    it("never makes the call speak", async () => {
      const { client, calls } = twilio([{ match: `POST ${ACCOUNT}/Calls.json`, json: { sid: "CAparent" } }]);

      await client.placeCall({ memberPhone: MEMBER, prospectPhone: PROSPECT, reference: "step-1" });

      expect(new URLSearchParams(calls[0].body).get("Twiml")).not.toContain("<Say");
    });

    it("escapes what it writes into TwiML", async () => {
      const { fetch, calls } = fakeFetch([{ match: `POST ${ACCOUNT}/Calls.json`, json: { sid: "CAparent" } }]);
      const client = twilioAdapter(adapterContext(FIELDS, fetch, { hookUrl: "https://coldlyne.test/hook?token=a&b=<c>" }));

      await client.placeCall({ memberPhone: MEMBER, prospectPhone: PROSPECT, reference: "step-1" });

      expect(new URLSearchParams(calls[0].body).get("Twiml")).toContain('statusCallback="https://coldlyne.test/hook?token=a&amp;b=&lt;c&gt;"');
    });
  });

  describe("leaving a voicemail", () => {
    it("redirects the prospect's leg of the member's call to the recording, then hangs up", async () => {
      const { client, calls } = twilio([
        { match: `GET ${ACCOUNT}/Calls.json`, json: { calls: [{ sid: "CAchild" }] } },
        { match: `POST ${ACCOUNT}/Calls/CAchild.json`, json: { sid: "CAchild" } },
      ]);

      await client.dropVoicemail("CAparent", "https://coldlyne.test/voicemails/a.mp3?v=1&w=2");

      expect(Object.fromEntries(new URL(calls[0].url).searchParams)).toEqual({ ParentCallSid: "CAparent", Status: "in-progress" });
      expect(Object.fromEntries(new URLSearchParams(calls[1].body))).toEqual({
        Twiml: "<Response><Play>https://coldlyne.test/voicemails/a.mp3?v=1&amp;w=2</Play><Hangup/></Response>",
        StatusCallback: `${HOOK}&outcome=voicemail_left`,
        StatusCallbackMethod: "POST",
      });
    });

    it("leaves nothing when the prospect's line isn't up", async () => {
      const { client, calls } = twilio([{ match: `GET ${ACCOUNT}/Calls.json`, json: { calls: [] } }]);

      await expect(client.dropVoicemail("CAparent", "https://coldlyne.test/a.mp3")).rejects.toThrow("Aucun appel en cours vers le prospect\u00A0: le message n’a pas été laissé.");
      expect(calls).toHaveLength(1);
    });
  });

  describe("the signature", () => {
    // Twilio's worked example, https://www.twilio.com/docs/usage/security
    const URL_SIGNED = "https://example.com/myapp.php?foo=1&bar=2";
    const PARAMS = new URLSearchParams({ To: "+18005551212", Digits: "1234", CallSid: "CA1234567890ABCDE", From: "+14158675310", Caller: "+14158675310" });
    const KNOWN_ANSWER = "L/OH5YylLD5NRKLltdqwSvS0BnU=";

    it("gives Twilio's documented answer", () => {
      expect(twilioSignature(URL_SIGNED, PARAMS, "12345")).toBe(KNOWN_ANSWER);
    });

    it("accepts the documented request, and a form-encoded plus reads as a plus", () => {
      const request = inbound(PARAMS.toString(), { "x-twilio-signature": KNOWN_ANSWER }, URL_SIGNED);

      expect(() => assertFromTwilio(request, new URLSearchParams(request.body), "12345")).not.toThrow();
    });

    it("accepts an address received with a port Twilio signed without", () => {
      const request = inbound(PARAMS.toString(), { "x-twilio-signature": KNOWN_ANSWER }, "https://example.com:443/myapp.php?foo=1&bar=2");

      expect(() => assertFromTwilio(request, new URLSearchParams(request.body), "12345")).not.toThrow();
    });

    it("takes repeated parameters as Twilio's library does: distinct values, sorted", () => {
      const once = new URLSearchParams("a=1&b=2");
      const repeated = new URLSearchParams("b=2&a=1&b=2");

      expect(twilioSignature(URL_SIGNED, repeated, "12345")).toBe(twilioSignature(URL_SIGNED, once, "12345"));
    });

    it("refuses a forged signature, another token and a changed parameter", () => {
      const forged = inbound(PARAMS.toString(), { "x-twilio-signature": "AAAAYylLD5NRKLltdqwSvS0BnU=" }, URL_SIGNED);
      const changed = new URLSearchParams(PARAMS);
      changed.set("To", "+18005551213");
      const tampered = inbound(changed.toString(), { "x-twilio-signature": KNOWN_ANSWER }, URL_SIGNED);

      expect(() => assertFromTwilio(forged, new URLSearchParams(forged.body), "12345")).toThrow("Message non lu\u00A0: rien ne prouve qu’il a été envoyé par Twilio.");
      expect(() => assertFromTwilio(inbound(PARAMS.toString(), { "x-twilio-signature": KNOWN_ANSWER }, URL_SIGNED), PARAMS, "54321")).toThrow();
      expect(() => assertFromTwilio(tampered, new URLSearchParams(tampered.body), "12345")).toThrow();
      expect(() => assertFromTwilio(inbound(PARAMS.toString(), {}, URL_SIGNED), PARAMS, "12345")).toThrow();
    });
  });

  describe("reading a call's end", () => {
    const leg = (fields: Record<string, string>) => new URLSearchParams({ CallSid: "CAchild", ParentCallSid: "CAparent", To: PROSPECT, Timestamp: "Wed, 04 Nov 2026 10:00:00 +0000", ...fields });
    const read = async (params: URLSearchParams, url = HOOK) => {
      const { client } = twilio([]);
      return client.readWebhook(inbound(params.toString(), { "x-twilio-signature": twilioSignature(url, params, FIELDS.authToken) }, url));
    };

    it("is answered, with the time on the line, when the prospect's leg completed", async () => {
      expect((await read(leg({ CallStatus: "completed", CallDuration: "125" }))).signals).toEqual([
        { type: "answered", channel: "call", externalId: "CAchild", address: PROSPECT, at: new Date("2026-11-04T10:00:00Z"), detail: "2\u00A0min\u00A05\u00A0s" },
      ]);
    });

    it.each([
      ["busy", "no_answer"],
      ["no-answer", "no_answer"],
      ["canceled", "no_answer"],
      ["failed", "failed"],
    ])("reads %s as %s, with no duration", async (status, type) => {
      const { signals } = await read(leg({ CallStatus: status, CallDuration: "0" }));

      expect(signals).toEqual([{ type, channel: "call", externalId: "CAchild", address: PROSPECT, at: new Date("2026-11-04T10:00:00Z"), detail: undefined }]);
    });

    it("is a voicemail left when it comes from the leg redirected to the recording", async () => {
      const url = `${HOOK}&outcome=voicemail_left`;

      expect((await read(leg({ CallStatus: "completed", CallDuration: "42" }), url)).signals).toEqual([
        { type: "voicemail_left", channel: "call", externalId: "CAchild:voicemail", address: PROSPECT, at: new Date("2026-11-04T10:00:00Z"), detail: "42\u00A0s" },
      ]);
    });

    it("isn't a voicemail left if the recording's leg failed", async () => {
      const { signals } = await read(leg({ CallStatus: "failed" }), `${HOOK}&outcome=voicemail_left`);

      expect(signals[0]).toMatchObject({ type: "failed", externalId: "CAchild" });
    });

    it("says nothing from the member's own leg, or while the call is still going", async () => {
      const memberLeg = new URLSearchParams({ CallSid: "CAparent", To: MEMBER, CallStatus: "completed", CallDuration: "60" });

      expect((await read(memberLeg)).signals).toEqual([]);
      expect((await read(leg({ CallStatus: "in-progress" }))).signals).toEqual([]);
    });

    it("dates it now when Twilio gave no timestamp", async () => {
      const params = leg({ CallStatus: "completed", CallDuration: "5" });
      params.delete("Timestamp");

      expect((await read(params)).signals[0].at).toEqual(new Date("2026-11-04T09:00:00Z"));
    });

    it("refuses a forged callback", async () => {
      const { client } = twilio([]);

      await expect(client.readWebhook(inbound(leg({ CallStatus: "completed" }).toString(), { "x-twilio-signature": "forged" }))).rejects.toThrow("rien ne prouve qu’il a été envoyé par Twilio.");
    });
  });
});

describe("Aircall", () => {
  const API = "https://api.aircall.io/v1";
  const FIELDS = { apiId: "api-id", apiToken: "api-token" };
  const NUMBERS = { numbers: [{ id: 1, digits: "+33 1 76 11 11 11" }, { id: 2, digits: "+33 6 12 34 56 78" }], meta: { next_page_link: null } };
  const aircall = (routes: FakeRoute[]) => {
    const { fetch, calls } = fakeFetch(routes);
    return { client: aircallAdapter(adapterContext(FIELDS, fetch)), calls };
  };

  describe("its check", () => {
    it("names the company and its numbers", async () => {
      const { client, calls } = aircall([
        { match: `GET ${API}/company`, json: { company: { name: "Northwind" } } },
        { match: `GET ${API}/numbers`, json: NUMBERS },
      ]);

      expect(await client.check()).toEqual({ ok: true, label: "Northwind", detail: "2 numéros\u00A0: +33 1 76 11 11 11, +33 6 12 34 56 78" });
      expect(calls[0].headers.get("authorization")).toBe(`Basic ${Buffer.from("api-id:api-token").toString("base64")}`);
    });

    it("reads every page of the numbers", async () => {
      const { client, calls } = aircall([
        { match: `GET ${API}/company`, json: { company: { name: "Northwind" } } },
        { match: `GET ${API}/numbers?per_page=50&page=1`, json: { numbers: [{ id: 1, digits: "+33 1" }], meta: { next_page_link: `${API}/numbers?page=2` } } },
        { match: `GET ${API}/numbers?per_page=50&page=2`, json: { numbers: [{ id: 2, digits: "+33 2" }], meta: { next_page_link: null } } },
      ]);

      expect(await client.check()).toMatchObject({ detail: "2 numéros\u00A0: +33 1, +33 2" });
      expect(calls).toHaveLength(3);
    });

    it("refuses an account with no number to call from", async () => {
      const { client } = aircall([
        { match: `GET ${API}/company`, json: { company: { name: "Northwind" } } },
        { match: `GET ${API}/numbers`, json: { numbers: [], meta: {} } },
      ]);

      expect(await client.check()).toEqual({ ok: false, detail: "Aucun numéro sur le compte Aircall Northwind." });
    });

    it("says what Aircall refused", async () => {
      const { client } = aircall([{ match: `GET ${API}/company`, status: 403, json: { error: "Forbidden" } }]);

      expect(await client.check()).toEqual({ ok: false, detail: "Aircall a refusé l’accès : Forbidden" });
    });
  });

  describe("placing a call", () => {
    const line = (users: { id: number }[]) => [{ match: `GET ${API}/numbers/2`, json: { number: { id: 2, digits: "+33 6 12 34 56 78", users } } }, { match: `GET ${API}/numbers`, json: NUMBERS }];

    it("starts it in the app of the one person assigned to the member's line", async () => {
      // Aircall answers 204. fakeFetch can't build one, and an empty 200 reads the same.
      const { client, calls } = aircall([...line([{ id: 456 }]), { match: `POST ${API}/users/456/calls` }]);

      const placed = await client.placeCall({ memberPhone: MEMBER, prospectPhone: PROSPECT, reference: "step-1" });

      expect(placed).toEqual({ externalId: "step-1" });
      expect(calls.at(-1)?.method).toBe("POST");
      expect(calls.at(-1)?.url).toBe(`${API}/users/456/calls`);
      expect(JSON.parse(calls.at(-1)?.body ?? "")).toEqual({ number_id: 2, to: PROSPECT });
    });

    it("refuses a number that isn't one of the account's lines", async () => {
      const { client } = aircall(line([]));

      await expect(client.placeCall({ memberPhone: "+33700000000", prospectPhone: PROSPECT, reference: "step-1" })).rejects.toThrow("Le numéro +33700000000 n’est pas une ligne de ce compte Aircall.");
    });

    it("refuses a line nobody is assigned to, and a shared one rather than ring the wrong person", async () => {
      await expect(aircall(line([])).client.placeCall({ memberPhone: MEMBER, prospectPhone: PROSPECT, reference: "step-1" })).rejects.toThrow("n’est attribuée à personne");

      const shared = aircall(line([{ id: 456 }, { id: 789 }]));
      await expect(shared.client.placeCall({ memberPhone: MEMBER, prospectPhone: PROSPECT, reference: "step-1" })).rejects.toThrow("est partagée\u00A0: Coldlyne ne peut pas savoir à qui lancer l’appel.");
      expect(shared.calls.every((call) => call.method === "GET")).toBe(true);
    });

    it("says when the member isn't available, and lets other refusals through", async () => {
      const busy = aircall([...line([{ id: 456 }]), { match: `POST ${API}/users/456/calls`, status: 405, json: { message: "User not available" } }]);
      await expect(busy.client.placeCall({ memberPhone: MEMBER, prospectPhone: PROSPECT, reference: "step-1" })).rejects.toThrow("La personne n’est pas disponible dans Aircall\u00A0: elle doit être connectée à l’application, hors appel.");

      const invalid = aircall([...line([{ id: 456 }]), { match: `POST ${API}/users/456/calls`, status: 400, json: { message: "Invalid number" } }]);
      await expect(invalid.client.placeCall({ memberPhone: MEMBER, prospectPhone: PROSPECT, reference: "step-1" })).rejects.toThrow("Aircall a refusé la demande : Invalid number");
    });
  });

  describe("reading its events", () => {
    const REGISTERED = { match: `GET ${API}/webhooks`, json: { webhooks: [{ url: "https://elsewhere.test/hook", token: "other" }, { url: HOOK, token: "webhook-token" }], meta: { next_page_link: null } } };
    const event = (name: string, data: Record<string, unknown> = {}, token = "webhook-token") =>
      JSON.stringify({ resource: "call", event: name, timestamp: 1793786400, token, data: { id: 812, direction: "outbound", raw_digits: "+33 6 98 76 54 32", ...data } });

    it("reads a call that ended answered, with the time on the line rather than the ringing", async () => {
      const { client } = aircall([REGISTERED]);

      const { signals } = await client.readWebhook(inbound(event("call.ended", { started_at: 1793786000, answered_at: 1793786010, ended_at: 1793786100, duration: 100 })));

      expect(signals).toEqual([{ type: "answered", channel: "call", externalId: "812", address: PROSPECT, at: new Date(1793786100 * 1000), detail: "1\u00A0min\u00A030\u00A0s" }]);
    });

    it("reads a call that ended unanswered", async () => {
      const { client } = aircall([REGISTERED]);

      const { signals } = await client.readWebhook(inbound(event("call.ended", { answered_at: null, ended_at: 1793786100 })));

      expect(signals).toEqual([{ type: "no_answer", channel: "call", externalId: "812", address: PROSPECT, at: new Date(1793786100 * 1000), detail: undefined }]);
    });

    it("reads a voicemail left on an outbound call", async () => {
      const { client } = aircall([REGISTERED]);

      expect((await client.readWebhook(inbound(event("call.voicemail_left")))).signals[0]).toMatchObject({ type: "voicemail_left", externalId: "812", at: new Date(1793786400 * 1000) });
    });

    it("has no address for an anonymous number", async () => {
      const { client } = aircall([REGISTERED]);

      expect((await client.readWebhook(inbound(event("call.ended", { raw_digits: "anonymous" })))).signals[0].address).toBeNull();
    });

    it("reads a call coming in as the person answering, once, at its end", async () => {
      const { client } = aircall([REGISTERED]);

      expect((await client.readWebhook(inbound(event("call.ended", { direction: "inbound", ended_at: 1793786100 })))).signals).toEqual([{ type: "replied", channel: "call", externalId: "812", address: PROSPECT, at: new Date(1793786100 * 1000), detail: "A rappelé" }]);
      expect((await client.readWebhook(inbound(event("call.voicemail_left", { direction: "inbound" })))).signals).toEqual([]);
    });

    it("asks Aircall nothing for events it doesn't read", async () => {
      const { client, calls } = aircall([]);

      expect((await client.readWebhook(inbound(event("call.answered")))).signals).toEqual([]);
      expect((await client.readWebhook(inbound(event("call.hungup")))).signals).toEqual([]);
      expect(calls).toEqual([]);
    });

    it("refuses another token, and a webhook Aircall doesn't have on this address", async () => {
      await expect(aircall([REGISTERED]).client.readWebhook(inbound(event("call.ended", {}, "forged")))).rejects.toThrow("rien ne prouve qu’il a été envoyé par Aircall.");

      const elsewhere = { match: `GET ${API}/webhooks`, json: { webhooks: [{ url: "https://elsewhere.test/hook", token: "webhook-token" }], meta: {} } };
      await expect(aircall([elsewhere]).client.readWebhook(inbound(event("call.ended")))).rejects.toThrow("rien ne prouve qu’il a été envoyé par Aircall.");
    });

    it("refuses what it can't read", async () => {
      const { client } = aircall([]);

      await expect(client.readWebhook(inbound("not json"))).rejects.toThrow("Aircall a envoyé un message illisible.");
      await expect(client.readWebhook(inbound("null"))).rejects.toThrow("Aircall a envoyé un message illisible.");
    });
  });
});

describe("Ringover", () => {
  const API = "https://public-api.ringover.com/v2";
  const FIELDS = { apiKey: "ringover-key" };
  const ringover = (routes: FakeRoute[], fields: Record<string, string> = FIELDS) => {
    const { fetch, calls } = fakeFetch(routes);
    return { client: ringoverAdapter(adapterContext(fields, fetch)), calls };
  };

  describe("its check", () => {
    it("names the team and its numbers, with the key alone in the header", async () => {
      const { client, calls } = ringover([{ match: `GET ${API}/teams`, json: { name: "Northwind", numbers: [{ number: 33184800000, format: { e164: "+33184800000" } }, { number: 33184800001 }] } }]);

      expect(await client.check()).toEqual({ ok: true, label: "Northwind", detail: "2 numéros\u00A0: +33184800000, +33184800001" });
      expect(calls[0].headers.get("authorization")).toBe("ringover-key");
    });

    it("accepts a key that can't see the team's numbers", async () => {
      const { client } = ringover([{ match: `GET ${API}/teams`, json: {} }]);

      expect(await client.check()).toEqual({ ok: true, label: "Ringover", detail: "Clé d’API acceptée." });
    });

    it("says what Ringover refused", async () => {
      const { client } = ringover([{ match: `GET ${API}/teams`, status: 401, json: { title: "Unauthorized" } }]);

      expect(await client.check()).toEqual({ ok: false, detail: "Ringover a refusé les identifiants : Unauthorized" });
    });
  });

  describe("placing a call", () => {
    it("asks for a callback from the member to the prospect, in Ringover's integers", async () => {
      const { client, calls } = ringover([{ match: `POST ${API}/callback`, json: { call_id: "abc" } }]);

      expect(await client.placeCall({ memberPhone: MEMBER, prospectPhone: PROSPECT, reference: "step-1" })).toEqual({ externalId: "abc" });
      expect(calls[0].headers.get("authorization")).toBe("ringover-key");
      expect(calls[0].body).toBe('{"from_number":33612345678,"to_number":33698765432}');
    });

    it("keeps its reference when Ringover gives no id it can keep whole", async () => {
      const { client } = ringover([{ match: `POST ${API}/callback`, json: { call_id: 1234567890987654400 } }]);
      const empty = ringover([{ match: `POST ${API}/callback` }]);

      expect(await client.placeCall({ memberPhone: MEMBER, prospectPhone: PROSPECT, reference: "step-1" })).toEqual({ externalId: "step-1" });
      expect(await empty.client.placeCall({ memberPhone: MEMBER, prospectPhone: PROSPECT, reference: "step-1" })).toEqual({ externalId: "step-1" });
    });
  });

  describe("reading its events", () => {
    const event = (name: string, data: Record<string, unknown> = {}, resource = "call") =>
      JSON.stringify({ event: name, resource, timestamp: 1793786400.5, data: { id: "57622f20-a020", call_id: 1234567890987654400, direction: "outbound", from_number: "33612345678", to_number: "33698765432", is_internal: false, hangup_time: 1793786100, ...data } });
    const read = (body: string) => ringover([]).client.readWebhook(inbound(body));

    it("reads a hangup with a duration as answered", async () => {
      expect((await read(event("hangup", { duration_in_seconds: 32 }))).signals).toEqual([{ type: "answered", channel: "call", externalId: "57622f20-a020", address: PROSPECT, at: new Date(1793786100 * 1000), detail: "32\u00A0s" }]);
    });

    it.each([[0], [null]])("reads a hangup with a duration of %s as unanswered", async (seconds) => {
      expect((await read(event("hangup", { duration_in_seconds: seconds }))).signals[0]).toMatchObject({ type: "no_answer", detail: undefined });
    });

    it("reads a missed call as unanswered, and a voicemail on an outbound call as left", async () => {
      expect((await read(event("missed", { reason: "NO_ANSWER", status: "missed" }))).signals[0]).toMatchObject({ type: "no_answer", address: PROSPECT });
      expect((await read(event("voicemail", { duration_in_seconds: 12 }))).signals[0]).toMatchObject({ type: "voicemail_left", detail: "12\u00A0s" });
    });

    it.each(["hangup", "missed"])("reads a call coming in that ends with %s as the person answering", async (name) => {
      expect((await read(event(name, { direction: "inbound", from_number: "33698765432", to_number: "33612345678" }))).signals).toEqual([{ type: "replied", channel: "call", externalId: "57622f20-a020", address: PROSPECT, at: new Date(1793786100 * 1000), detail: "A rappelé" }]);
    });

    it("leaves out what isn't a call with a prospect, or isn't its end", async () => {
      const notRead = [event("voicemail", { direction: "inbound" }), event("hangup", { direction: "elsewhere" }), event("hangup", { is_internal: true, duration_in_seconds: 32 }), event("ringing"), event("answered"), event("record_available", {}, "aftercall"), event("hangup", { id: undefined })];

      for (const body of notRead) expect((await read(body)).signals).toEqual([]);
    });

    it("dates it from the event when no hangup time is given", async () => {
      expect((await read(event("missed", { hangup_time: undefined }))).signals[0].at).toEqual(new Date(1793786400.5 * 1000));
    });

    it("refuses what it can't read", async () => {
      await expect(read("not json")).rejects.toThrow("Ringover a envoyé un message illisible.");
    });
  });

  describe("its signature, once a secret is saved", () => {
    // Made apart from this code: a JWT in HS512, keyed with "ringover-secret".
    const SIGNED = "eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9.eyJmb28iOiJiYXIifQ.Az6-yK_jvkAqdlmiGB0s-u_FHZflP_c9ibfiIbViDfPOOtq84YK-UaHbWv9mWRkDHsB0Jzhdy1eRnPvYd9LjrA";
    const EXPIRED = "eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9.eyJmb28iOiJiYXIiLCJleHAiOjE3MDAwMDAwMDB9.EQHBtjaZrA042Bs-hWj2nkNYGnnEkJoWJ_LTn1kot1HVzIUsveWSUGUYgEru7PRPhgQ9cHTPlEpWG-WZIhHVJw";
    const BODY = JSON.stringify({ event: "missed", resource: "call", data: { id: "a", direction: "outbound", to_number: "33698765432" } });
    const signedRead = (token?: string) => ringover([], { ...FIELDS, webhookSecret: "ringover-secret" }).client.readWebhook(inbound(BODY, token ? { "x-ringover-webhook-signature": token } : {}));

    it("reads a request Ringover signed", async () => {
      expect((await signedRead(SIGNED)).signals).toHaveLength(1);
    });

    it("refuses a forged, an expired or a missing signature", async () => {
      await expect(signedRead(`${SIGNED.slice(0, -4)}AAAA`)).rejects.toThrow("rien ne prouve qu’il a été envoyé par Ringover.");
      await expect(signedRead(EXPIRED)).rejects.toThrow("rien ne prouve qu’il a été envoyé par Ringover.");
      await expect(signedRead("not-a-jwt")).rejects.toThrow("rien ne prouve qu’il a été envoyé par Ringover.");
      await expect(signedRead()).rejects.toThrow("rien ne prouve qu’il a été envoyé par Ringover.");
    });

    it("refuses a JWT claiming no algorithm", async () => {
      const header = Buffer.from('{"alg":"none"}').toString("base64url");

      await expect(signedRead(`${header}.${SIGNED.split(".")[1]}.`)).rejects.toThrow("rien ne prouve qu’il a été envoyé par Ringover.");
    });
  });
});
