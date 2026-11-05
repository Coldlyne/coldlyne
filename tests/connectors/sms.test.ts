import { describe, expect, it } from "vitest";
import type { InboundRequest, Signal } from "@/application/ports";
import { adapterOf } from "@/infrastructure/connectors";
import { OVH_API, ovhSignature } from "@/infrastructure/connectors/ovh";
import { brevoSms } from "@/infrastructure/connectors/sms/brevo";
import { ovhSms } from "@/infrastructure/connectors/sms/ovh-sms";
import { e164, isStop, readDate, replySignal, webhookEvents } from "@/infrastructure/connectors/sms/signals";
import { smsmode } from "@/infrastructure/connectors/sms/smsmode";
import { creditsLeft, fitsGsm7, withoutStopMention } from "@/infrastructure/connectors/sms/text";
import { adapterContext, fakeFetch, type FakeRoute } from "../support/fetch";

const NOW = new Date("2026-11-04T09:00:00Z");
const HOOK = "https://coldlyne.test/api/hooks/00000000-0000-4000-8000-000000000000?token=hook-token";
const TEXT = "Bonjour Jeanne, Northwind vous écrit au sujet de vos holdings. STOP au 36111";
const TEXT_WITHOUT_STOP = "Bonjour Jeanne, Northwind vous écrit au sujet de vos holdings.";

/** What a provider posted, as the route hands it on. */
const posted = (body: unknown): InboundRequest => ({ method: "POST", url: HOOK, headers: new Headers({ "content-type": "application/json" }), body: typeof body === "string" ? body : JSON.stringify(body) });

const failingFetch = (async () => {
  throw new TypeError("fetch failed");
}) as typeof fetch;

describe("a STOP in a reply", () => {
  it.each(["STOP", "stop", " Stop ", "ARRET", "arret", "ARRÊT", "Arrêt", "STOP SMS", "stop  sms", "StopSms", "S T O P", "STOP.", "stop !"])("reads %j as a request to stop", (text) => {
    expect(isStop(text)).toBe(true);
  });

  it.each(["", "Bonjour", "Ne pas stopper", "Stop, appelez-moi plutôt", "Arrêtez de m'écrire svp", "OK", "non-stop"])("reads %j as an ordinary reply", (text) => {
    expect(isStop(text)).toBe(false);
  });

  it("opts the sender out, or counts as a reply, with the sender in E.164", () => {
    expect(replySignal({ externalId: "r1", from: "33612345678", text: "ARRÊT", at: NOW })).toEqual({ type: "opted_out", channel: "sms", externalId: "stop:+33612345678", address: "+33612345678", at: NOW, detail: "ARRÊT" });
    expect(replySignal({ externalId: "r2", from: "+33612345678", text: " Rappelez-moi demain ", at: NOW })).toEqual({ type: "replied", channel: "sms", externalId: "r2", address: "+33612345678", at: NOW, detail: "Rappelez-moi demain" });
  });
});

describe("a number from a provider", () => {
  it.each([
    ["+33612345678", "+33612345678"],
    ["33612345678", "+33612345678"],
    ["0033612345678", "+33612345678"],
    ["0612345678", "+33612345678"],
    ["+33 6 12 34 56 78", "+33612345678"],
    ["+32470123456", "+32470123456"],
  ])("reads %s as %s", (raw, expected) => {
    expect(e164(raw)).toBe(expected);
  });

  it.each(["", "NORTHWIND", "36111", "+0612345678"])("leaves %j without an address", (raw) => {
    expect(e164(raw)).toBeNull();
  });
});

describe("the text of an SMS", () => {
  it.each([
    ["Bonjour. STOP au 36111", "Bonjour."],
    ["Bonjour.\nSTOP 36034", "Bonjour."],
    ["Bonjour. Répondre STOP au 36111.", "Bonjour."],
    ["Bonjour. STOP SMS au 36111", "Bonjour."],
    ["Bonjour. Stop au XXXXX", "Bonjour."],
    ["Bonjour. STOP au [STOP_CODE]", "Bonjour."],
    ["Bonjour. STOP", "Bonjour."],
    ["Un service non-stop", "Un service non-stop"],
    ["STOP au 36111 pour arrêter, merci", "STOP au 36111 pour arrêter, merci"],
  ])("takes the STOP mention off %j", (text, expected) => {
    expect(withoutStopMention(text)).toBe(expected);
  });

  it("knows which texts fit the SMS alphabet", () => {
    expect(fitsGsm7("Bonjour, à très bientôt ? Hélène")).toBe(false); // ô isn't in it
    expect(fitsGsm7("Bonjour, à très vite ! Hélène [100€]")).toBe(true);
    expect(fitsGsm7("l’équipe")).toBe(false); // nor is the typographic apostrophe
    expect(fitsGsm7("ça")).toBe(false);
  });

  it("counts credits in French", () => {
    expect(creditsLeft(0)).toBe("0 crédit SMS restant");
    expect(creditsLeft(1.5)).toBe("1 crédit SMS restant");
    expect(creditsLeft(15)).toBe("15 crédits SMS restants");
    expect(creditsLeft(11488.845)).toBe("11 488 crédits SMS restants");
  });
});

describe("what a provider writes", () => {
  it("reads a date with its zone, without one as UTC, and falls back on an unreadable one", () => {
    expect(readDate("2026-11-04T10:00:00+01:00", NOW)).toEqual(new Date("2026-11-04T09:00:00Z"));
    expect(readDate("2026-11-04T10:00:00", NOW)).toEqual(new Date("2026-11-04T10:00:00Z"));
    expect(readDate("2026-11-04T10:00:00Z", NOW)).toEqual(new Date("2026-11-04T10:00:00Z"));
    expect(readDate(undefined, NOW)).toBe(NOW);
    expect(readDate("hier", NOW)).toBe(NOW);
  });

  it("reads one event or a batch, and refuses what isn't JSON", () => {
    expect(webhookEvents("Brevo", '{"a":1}')).toEqual([{ a: 1 }]);
    expect(webhookEvents("Brevo", '[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(() => webhookEvents("Brevo", "pas du json")).toThrow("Brevo a envoyé une notification illisible.");
    expect(() => webhookEvents("Brevo", "12")).toThrow("Brevo a envoyé une notification illisible.");
  });
});

describe("the SMS connectors", () => {
  it("are found by their kind", () => {
    expect(adapterOf("brevo_sms")).toBe(brevoSms);
    expect(adapterOf("ovh_sms")).toBe(ovhSms);
    expect(adapterOf("smsmode")).toBe(smsmode);
  });
});

describe("Brevo", () => {
  const FIELDS = { apiKey: "brevo-key", sender: "NORTHWIND" };
  const ACCOUNT = "GET https://api.brevo.com/v3/account";
  const SEND = "POST https://api.brevo.com/v3/transactionalSMS/send";
  const signalsOf = async (body: unknown): Promise<Signal[]> => (await brevoSms(adapterContext(FIELDS, fakeFetch([]).fetch)).readWebhook!(posted(body))).signals;

  it("checks the key on the account, named by its company, with its SMS credits", async () => {
    const { fetch, calls } = fakeFetch([{ match: ACCOUNT, json: { email: "f@northwind.fr", companyName: "Northwind", plan: [{ credits: 250, creditsType: "sendLimit", type: "free" }, { credits: 15, creditsType: "sendLimit", type: "sms" }] } }]);

    expect(await brevoSms(adapterContext(FIELDS, fetch)).check()).toEqual({ ok: true, label: "Northwind", detail: "15 crédits SMS restants" });
    expect(calls[0].headers.get("api-key")).toBe("brevo-key");
  });

  it("names an account without a company by its address, and without SMS credits says so", async () => {
    const { fetch } = fakeFetch([{ match: ACCOUNT, json: { email: "f@northwind.fr", plan: [{ credits: 250, type: "free" }] } }]);

    expect(await brevoSms(adapterContext(FIELDS, fetch)).check()).toEqual({ ok: true, label: "f@northwind.fr", detail: "0 crédit SMS restant" });
  });

  it("says when the key is refused", async () => {
    const { fetch } = fakeFetch([{ match: ACCOUNT, status: 401, json: { code: "unauthorized", message: "Key not found" } }]);
    const check = await brevoSms(adapterContext(FIELDS, fetch)).check();

    expect(check.ok).toBe(false);
    expect(check.detail).toContain("Brevo a refusé les identifiants");
    expect(check.detail).toContain("Key not found");
  });

  it("says in French when it can't be reached", async () => {
    expect(await brevoSms(adapterContext(FIELDS, failingFetch)).check()).toEqual({ ok: false, detail: "Brevo ne répond pas correctement pour le moment." });
  });

  it("sends a marketing SMS with its own STOP code in place of the text's mention", async () => {
    const { fetch, calls } = fakeFetch([{ match: SEND, status: 201, json: { messageId: 1511882900176220 } }]);

    const sent = await brevoSms(adapterContext(FIELDS, fetch)).sendSms!({ to: "+33612345678", text: TEXT });

    expect(sent).toEqual({ externalId: "1511882900176220" });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://api.brevo.com/v3/transactionalSMS/send");
    expect(calls[0].headers.get("api-key")).toBe("brevo-key");
    expect(calls[0].headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(calls[0].body)).toEqual({ sender: "NORTHWIND", recipient: "33612345678", content: `${TEXT_WITHOUT_STOP} STOP au [STOP_CODE]`, type: "marketing", webUrl: HOOK, unicodeEnabled: false });
  });

  it("asks for Unicode only when the text needs it", async () => {
    const { fetch, calls } = fakeFetch([{ match: SEND, status: 201, json: { messageId: 1 } }]);

    await brevoSms(adapterContext(FIELDS, fetch)).sendSms!({ to: "+33612345678", text: "Êtes-vous l’équipe ? STOP au 36111" });

    expect(JSON.parse(calls[0].body)).toMatchObject({ content: "Êtes-vous l’équipe ? STOP au [STOP_CODE]", unicodeEnabled: true });
  });

  it("reads a reply, with the prospect in `to`", async () => {
    const reply = { id: 26519, msg_status: "replied", status: "OK", reference: { 1: "1hi8" }, error_code: 101, description: "replied", to: "33612345678", reply: "Rappelez-moi", ts_event: 1793782800, date: "2026-11-04 10:00:00", messageId: 123, type: "marketing" };

    expect(await signalsOf(reply)).toEqual([{ type: "replied", channel: "sms", externalId: "123:1793782800000", address: "+33612345678", at: new Date(1793782800000), detail: "Rappelez-moi" }]);
  });

  it("reads a STOP as an opt-out, and its unsubscribe event as the same one", async () => {
    const [stop] = await signalsOf({ msg_status: "replied", to: "33612345678", reply: "stop", ts_event: 1793782800, messageId: 123 });
    const [unsubscribed] = await signalsOf({ id: 26519, msg_status: "unsubscribed", status: "OK", description: "unsubscribed", to: "33612345678", ts_event: 1793782900, messageId: 123, error_code: 100 });

    expect(stop).toEqual({ type: "opted_out", channel: "sms", externalId: "stop:+33612345678", address: "+33612345678", at: new Date(1793782800000), detail: "stop" });
    expect(unsubscribed).toMatchObject({ type: "opted_out", externalId: stop.externalId, address: "+33612345678" });
  });

  it("reads a number on Brevo's blocklist as an opt-out, at the time it came, since the event has none", async () => {
    const [blocked] = (await brevoSms(adapterContext(FIELDS, fakeFetch([]).fetch)).readWebhook!(posted({ id: 26570, to: "33612345678", messageId: 123, msg_status: "bl", date: "2026-11-04 10:00:00" }))).signals;

    expect(blocked).toEqual({ type: "opted_out", channel: "sms", externalId: "stop:+33612345678", address: "+33612345678", at: NOW });
  });

  it("reads delivery reports as delivered or failed", async () => {
    const report = { status: "OK", to: "33612345678", ts_event: 1793782800, messageId: 123, type: "marketing" };

    expect(await signalsOf({ ...report, msg_status: "delivered", description: "delivered" })).toEqual([{ type: "delivered", channel: "sms", externalId: "123:delivered", address: "+33612345678", at: new Date(1793782800000) }]);
    expect(await signalsOf({ ...report, msg_status: "hard_bounce", bounce_type: "hard_bounce", description: "Message is undeliverable" })).toEqual([{ type: "failed", channel: "sms", externalId: "123:failed", address: "+33612345678", at: new Date(1793782800000), detail: "Message is undeliverable" }]);
    expect(await signalsOf({ ...report, msg_status: "soft_bounce", description: "Failed to deliver" })).toMatchObject([{ type: "failed", detail: "Failed to deliver" }]);
    expect(await signalsOf({ ...report, msg_status: "rej" })).toMatchObject([{ type: "failed", detail: "rej" }]);
  });

  it("keeps skipped messages apart, since they all have the message id 0", async () => {
    const [skipped] = await signalsOf({ msg_status: "skip", description: "skip", to: "33612345678", ts_event: 1793782800, messageId: 0 });

    expect(skipped).toMatchObject({ type: "failed", externalId: "33612345678:1793782800000:failed" });
  });

  it("reads a batch, and leaves out what isn't about a prospect's answer or a delivery", async () => {
    const signals = await signalsOf([
      { msg_status: "sent", to: "33612345678", sms_count: 1, credits_used: 1.5, messageId: 123 },
      { msg_status: "accepted", to: "33612345678", messageId: 123 },
      { msg_status: "subscribe", to: "33612345678", messageId: 123 },
      { msg_status: "delivered", ts_event: 1793782800 },
      { msg_status: "delivered", to: "33612345678", ts_event: 1793782800, messageId: 123 },
    ]);

    expect(signals.map((signal) => signal.type)).toEqual(["delivered"]);
  });

  it("refuses what it can't read", async () => {
    await expect(signalsOf("<html>")).rejects.toThrow("Brevo a envoyé une notification illisible.");
  });
});

describe("OVHcloud SMS", () => {
  const FIELDS = { applicationKey: "app-key", applicationSecret: "app-secret", consumerKey: "consumer-key", serviceName: "sms-ab12345-1", sender: "NORTHWIND" };
  const CREDENTIALS = { applicationKey: "app-key", applicationSecret: "app-secret", consumerKey: "consumer-key" };
  const ACCOUNT = `${OVH_API}/sms/sms-ab12345-1`;
  /** The test clock, in Unix seconds, and OVH's a little ahead of it. */
  const SERVER_TIME = 1793782812;
  const TIME: FakeRoute = { match: `GET ${OVH_API}/auth/time`, json: SERVER_TIME };
  const senderIs = (status: string): FakeRoute => ({ match: `GET ${ACCOUNT}/senders/NORTHWIND`, json: { sender: "NORTHWIND", status, type: "alpha" } });
  const accountRoute: FakeRoute = { match: `GET ${ACCOUNT}`, json: { name: "sms-ab12345-1", creditsLeft: 120, status: "enable", description: "" } };

  it("checks the account and that its sender can send", async () => {
    const { fetch, calls } = fakeFetch([TIME, senderIs("enable"), accountRoute]);

    expect(await ovhSms(adapterContext(FIELDS, fetch)).check()).toEqual({ ok: true, label: "sms-ab12345-1", detail: "120 crédits SMS restants" });
    expect(calls.map((call) => call.url)).toEqual([`${OVH_API}/auth/time`, ACCOUNT, `${ACCOUNT}/senders/NORTHWIND`]);
    expect(calls[1].headers.get("x-ovh-signature")).toBe(ovhSignature(CREDENTIALS, "GET", ACCOUNT, "", SERVER_TIME));
  });

  it.each([
    ["waitingValidation", "L’expéditeur NORTHWIND attend encore la validation d’OVHcloud."],
    ["refused", "L’expéditeur NORTHWIND a été refusé par OVHcloud."],
    ["disable", "L’expéditeur NORTHWIND est désactivé."],
  ])("says when its sender is %s", async (status, detail) => {
    const { fetch } = fakeFetch([TIME, senderIs(status), accountRoute]);

    expect(await ovhSms(adapterContext(FIELDS, fetch)).check()).toEqual({ ok: false, label: "sms-ab12345-1", detail });
  });

  it("says when the sender isn't on the account", async () => {
    const { fetch } = fakeFetch([TIME, { match: `GET ${ACCOUNT}/senders/NORTHWIND`, status: 404, json: { message: "does not exist" } }, accountRoute]);

    expect(await ovhSms(adapterContext(FIELDS, fetch)).check()).toEqual({ ok: false, label: "sms-ab12345-1", detail: "L’expéditeur NORTHWIND n’existe pas sur ce compte." });
  });

  it("says when the sender can't be read, rather than saying it is missing", async () => {
    const { fetch } = fakeFetch([TIME, { match: `GET ${ACCOUNT}/senders/NORTHWIND`, status: 503, text: "" }, accountRoute]);

    expect(await ovhSms(adapterContext(FIELDS, fetch)).check()).toMatchObject({ ok: false, detail: "OVHcloud ne répond pas correctement pour le moment." });
  });

  it("says when OVH refuses the keys", async () => {
    const { fetch } = fakeFetch([TIME, { match: `GET ${ACCOUNT}`, status: 403, json: { errorCode: "NOT_GRANTED_CALL", message: "This call has not been granted" } }]);
    const check = await ovhSms(adapterContext(FIELDS, fetch)).check();

    expect(check.ok).toBe(false);
    expect(check.detail).toContain("OVHcloud a refusé l’accès");
    expect(check.detail).toContain("This call has not been granted");
  });

  it("sends a job from the sender, leaving the STOP clause to OVH, signed over its ASCII body", async () => {
    const { fetch, calls } = fakeFetch([TIME, { match: `POST ${ACCOUNT}/jobs`, json: { totalCreditsRemoved: 1, invalidReceivers: [], ids: [27814656], validReceivers: ["+33612345678"] } }]);

    const sent = await ovhSms(adapterContext(FIELDS, fetch)).sendSms!({ to: "+33612345678", text: "Êtes-vous l’équipe ? STOP au 36111" });

    expect(sent).toEqual({ externalId: "27814656" });
    const call = calls[1];
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${ACCOUNT}/jobs`);
    expect(call.body).toBe('{"message":"\\u00cates-vous l\\u2019\\u00e9quipe ?","receivers":["+33612345678"],"sender":"NORTHWIND","noStopClause":false,"senderForResponse":false}');
    expect(JSON.parse(call.body).message).toBe("Êtes-vous l’équipe ?");
    expect(call.headers.get("x-ovh-application")).toBe("app-key");
    expect(call.headers.get("x-ovh-consumer")).toBe("consumer-key");
    expect(call.headers.get("x-ovh-timestamp")).toBe(String(SERVER_TIME));
    // Known answer, worked out apart from this code with shasum over the same ASCII body.
    expect(call.headers.get("x-ovh-signature")).toBe("$1$827f0bb7c337f24d3a1338805c61eb826ef49549");
  });

  it("says when OVH doesn't accept the number", async () => {
    const { fetch } = fakeFetch([TIME, { match: `POST ${ACCOUNT}/jobs`, json: { totalCreditsRemoved: 0, invalidReceivers: ["+33612345678"], ids: [], validReceivers: [] } }]);

    await expect(ovhSms(adapterContext(FIELDS, fetch)).sendSms!({ to: "+33612345678", text: TEXT })).rejects.toThrow("OVHcloud n’a pas accepté le numéro +33612345678.");
  });

  it("reads replies and new STOPs since a date, oldest first, the blocklist's older entries left out", async () => {
    const since = new Date("2026-11-04T08:00:00Z");
    const { fetch, calls } = fakeFetch([
      TIME,
      { match: `GET ${ACCOUNT}/incoming?`, json: [11, 12] },
      { match: `GET ${ACCOUNT}/incoming/11`, json: { id: 11, creationDatetime: "2026-11-04T09:30:00+01:00", credits: 1, message: "Rappelez-moi", sender: "+33611111111", tag: "" } },
      { match: `GET ${ACCOUNT}/incoming/12`, json: { id: 12, creationDatetime: "2026-11-04T09:10:00+01:00", credits: 1, message: "ARRÊT", sender: "+33622222222", tag: "" } },
      { match: `GET ${ACCOUNT}/blacklists/%2B33633333333`, json: { number: "+33633333333", dateCreation: "2026-11-04T09:20:00+01:00", batchID: "b", smsOutgoingID: 1 } },
      { match: `GET ${ACCOUNT}/blacklists/%2B33644444444`, json: { number: "+33644444444", dateCreation: "2026-10-01T09:20:00+02:00", batchID: "b", smsOutgoingID: 2 } },
      { match: `GET ${ACCOUNT}/blacklists`, json: ["+33633333333", "+33644444444"] },
    ]);

    const signals = await ovhSms(adapterContext(FIELDS, fetch)).signalsSince!(since);

    expect(signals).toEqual([
      { type: "opted_out", channel: "sms", externalId: "stop:+33622222222", address: "+33622222222", at: new Date("2026-11-04T08:10:00Z"), detail: "ARRÊT" },
      { type: "opted_out", channel: "sms", externalId: "stop:+33633333333", address: "+33633333333", at: new Date("2026-11-04T08:20:00Z") },
      { type: "replied", channel: "sms", externalId: "11", address: "+33611111111", at: new Date("2026-11-04T08:30:00Z"), detail: "Rappelez-moi" },
    ]);
    const incoming = calls.find((call) => call.url.includes("/incoming?"));
    expect(incoming?.url).toBe(`${ACCOUNT}/incoming?creationDatetime.from=2026-11-04T08%3A00%3A00.000Z`);
    expect(incoming?.headers.get("x-ovh-signature")).toBe(ovhSignature(CREDENTIALS, "GET", incoming!.url, "", SERVER_TIME));
  });
});

describe("smsmode", () => {
  const FIELDS = { apiKey: "smsmode-key", sender: "NORTHWIND" };
  const ORGANISATIONS = "GET https://rest.smsmode.com/commons/v1/organisations";
  const SEND = "POST https://rest.smsmode.com/sms/v1/messages";
  const signalsOf = async (body: unknown): Promise<Signal[]> => (await smsmode(adapterContext(FIELDS, fakeFetch([]).fetch)).readWebhook!(posted(body))).signals;
  const REPORT = { messageId: "67c15045", type: "SMS", direction: "MT", recipient: { to: "33612345678" }, from: "36034", body: { text: "message", encoding: "GSM7" } };

  it("checks the key on the organisation, with its balance", async () => {
    const { fetch, calls } = fakeFetch([{ match: ORGANISATIONS, json: { items: [{ name: "Northwind", state: "ACTIVATED", balance: { amount: 42.5, currency: "EUR", paymentType: "PRE_PAY", parentBilling: false } }] } }]);

    const check = await smsmode(adapterContext(FIELDS, fetch)).check();

    expect(check).toEqual({ ok: true, label: "Northwind", detail: "Solde : 42,50 €" });
    expect(calls[0].headers.get("x-api-key")).toBe("smsmode-key");
  });

  it("doesn't read a post-paid balance as what is left", async () => {
    const { fetch } = fakeFetch([{ match: ORGANISATIONS, json: { items: [{ name: "Northwind", balance: { amount: -245.2, currency: "EUR", paymentType: "POST_PAY" } }] } }]);

    expect(await smsmode(adapterContext(FIELDS, fetch)).check()).toEqual({ ok: true, label: "Northwind", detail: "Paiement après consommation" });
  });

  it("shows a balance in a currency it doesn't know as smsmode wrote it", async () => {
    const { fetch } = fakeFetch([{ match: ORGANISATIONS, json: { items: [{ name: "Northwind", balance: { amount: 10, currency: "crédits", paymentType: "PRE_PAY" } }] } }]);

    expect(await smsmode(adapterContext(FIELDS, fetch)).check()).toEqual({ ok: true, label: "Northwind", detail: "Solde\u00a0: 10 crédits" });
  });

  it("says when the key is refused, or finds nothing", async () => {
    const refused = await smsmode(adapterContext(FIELDS, fakeFetch([{ match: ORGANISATIONS, status: 401, json: { title: "Unauthorized" } }]).fetch)).check();

    expect(refused.ok).toBe(false);
    expect(refused.detail).toContain("smsmode a refusé les identifiants");
    expect(await smsmode(adapterContext(FIELDS, fakeFetch([{ match: ORGANISATIONS, json: { items: [] } }]).fetch)).check()).toEqual({ ok: false, detail: "Aucune organisation sur ce compte smsmode." });
  });

  it("sends with its own STOP in place of the text's mention, and asks for reports and replies at Coldlyne's address", async () => {
    const { fetch, calls } = fakeFetch([{ match: SEND, status: 201, json: { messageId: "67c15045-1067-4588-ba3c-737cc5051438", status: { value: "ENROUTE" } } }]);

    const sent = await smsmode(adapterContext(FIELDS, fetch)).sendSms!({ to: "+33612345678", text: TEXT });

    expect(sent).toEqual({ externalId: "67c15045-1067-4588-ba3c-737cc5051438" });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://rest.smsmode.com/sms/v1/messages");
    expect(calls[0].headers.get("x-api-key")).toBe("smsmode-key");
    expect(calls[0].headers.get("accept")).toBe("application/json");
    expect(calls[0].headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(calls[0].body)).toEqual({ recipient: { to: "33612345678" }, from: "NORTHWIND", body: { text: TEXT_WITHOUT_STOP, stop: true, encoding: "GSM7" }, callbackUrlStatus: HOOK, callbackUrlMo: HOOK });
  });

  it("asks for Unicode only when the text needs it", async () => {
    const { fetch, calls } = fakeFetch([{ match: SEND, status: 201, json: { messageId: "m1" } }]);

    await smsmode(adapterContext(FIELDS, fetch)).sendSms!({ to: "+33612345678", text: "Êtes-vous là ? STOP au 36111" });

    expect(JSON.parse(calls[0].body).body).toEqual({ text: "Êtes-vous là ?", stop: true, encoding: "UNICODE" });
  });

  it("reads a reply, and a STOP as an opt-out", async () => {
    const reply = { messageId: "mo-1", originMessageId: "67c15045", sentDate: "2026-11-04T09:30:00", type: "SMS", direction: "MO", recipient: { to: "38047" }, from: "33612345678", body: { text: "Rappelez-moi", encoding: "GSM7" } };

    expect(await signalsOf(reply)).toEqual([{ type: "replied", channel: "sms", externalId: "mo-1", address: "+33612345678", at: new Date("2026-11-04T09:30:00Z"), detail: "Rappelez-moi" }]);
    expect(await signalsOf({ ...reply, body: { text: "Stop SMS" } })).toEqual([{ type: "opted_out", channel: "sms", externalId: "stop:+33612345678", address: "+33612345678", at: new Date("2026-11-04T09:30:00Z"), detail: "Stop SMS" }]);
  });

  it("reads delivery reports as delivered or failed, with why", async () => {
    expect(await signalsOf({ ...REPORT, status: { value: "DELIVERED", deliveryDate: "2026-11-04T09:30:00" } })).toEqual([{ type: "delivered", channel: "sms", externalId: "67c15045:delivered", address: "+33612345678", at: new Date("2026-11-04T09:30:00Z") }]);
    expect(await signalsOf({ ...REPORT, status: { value: "UNDELIVERABLE", detail: "INVALID_PHONE_NUMBER", deliveryDate: "2026-11-04T09:30:00" } })).toEqual([{ type: "failed", channel: "sms", externalId: "67c15045:failed", address: "+33612345678", at: new Date("2026-11-04T09:30:00Z"), detail: "INVALID_PHONE_NUMBER" }]);
    expect(await signalsOf({ ...REPORT, status: { value: "UNDELIVERED" } })).toMatchObject([{ type: "failed", detail: "UNDELIVERED", at: NOW }]);
  });

  it("reads a send refused as blacklisted as the STOP it shows", async () => {
    expect(await signalsOf({ ...REPORT, status: { value: "UNDELIVERABLE", detail: "BLACKLISTED", deliveryDate: "2026-11-04T09:30:00" } })).toEqual([{ type: "opted_out", channel: "sms", externalId: "stop:+33612345678", address: "+33612345678", at: new Date("2026-11-04T09:30:00Z"), detail: "BLACKLISTED" }]);
  });

  it("leaves out a message still on its way, and what it can't place", async () => {
    expect(await signalsOf({ ...REPORT, status: { value: "ENROUTE", detail: "IN_PROGRESS" } })).toEqual([]);
    expect(await signalsOf({ status: { value: "DELIVERED" } })).toEqual([]);
    expect(await signalsOf({ direction: "MT", messageId: "m1", from: "36034" })).toEqual([]);
  });

  it("refuses what it can't read", async () => {
    await expect(signalsOf("<html>")).rejects.toThrow("smsmode a envoyé une notification illisible.");
  });
});
