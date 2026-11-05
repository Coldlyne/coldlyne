import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { InboundRequest } from "@/application/ports";
import { adapterOf } from "@/infrastructure/connectors";
import { whatsappCloudAdapter } from "@/infrastructure/connectors/whatsapp/cloud";
import { adapterContext, fakeFetch, type FakeRoute } from "../support/fetch";

const HOOK = "https://coldlyne.test/api/hooks/00000000-0000-4000-8000-000000000000?token=hook-token";
const NUMBER_URL = "https://graph.facebook.com/v26.0/123456";
const FIELDS = { phoneNumberId: "123456", businessAccountId: "789", accessToken: "system-user-token", appSecret: "app-secret" };

const whatsapp = (routes: FakeRoute[] = []) => {
  const { fetch, calls } = fakeFetch(routes);
  return { client: whatsappCloudAdapter(adapterContext(FIELDS, fetch)), calls };
};

const sign = (body: string, secret = FIELDS.appSecret) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

function post(body: string, signature = sign(body)): InboundRequest {
  return { method: "POST", url: HOOK, headers: new Headers({ "x-hub-signature-256": signature }), body };
}

function get(query: Record<string, string>): InboundRequest {
  const url = new URL(HOOK);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return { method: "GET", url: url.toString(), headers: new Headers(), body: "" };
}

const change = (value: Record<string, unknown>) => JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "789", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "33123456789", phone_number_id: "123456" }, ...value } }] }] });

const AT = new Date(1793786400 * 1000);

describe("the WhatsApp connector", () => {
  it("is registered by kind", () => {
    expect(adapterOf("whatsapp_cloud")).toBe(whatsappCloudAdapter);
  });
});

describe("its check", () => {
  it("names the number, with its verified name and quality, using the access token", async () => {
    const { client, calls } = whatsapp([{ match: `GET ${NUMBER_URL}`, json: { display_phone_number: "+33 1 23 45 67 89", verified_name: "Northwind", quality_rating: "GREEN" } }]);

    expect(await client.check()).toEqual({ ok: true, label: "+33 1 23 45 67 89", detail: "Northwind, qualité élevée" });
    expect(calls[0].url).toBe(NUMBER_URL);
    expect(calls[0].headers.get("authorization")).toBe("Bearer system-user-token");
  });

  it.each([
    ["YELLOW", "moyenne"],
    ["RED", "faible"],
    ["UNKNOWN", "inconnue"],
    ["NA", "inconnue"],
  ])("says %s as %s", async (rating, quality) => {
    const { client } = whatsapp([{ match: `GET ${NUMBER_URL}`, json: { display_phone_number: "1", verified_name: "Northwind", quality_rating: rating } }]);

    expect((await client.check()).detail).toBe(`Northwind, qualité ${quality}`);
  });

  it("says what Meta refused", async () => {
    const { client } = whatsapp([{ match: `GET ${NUMBER_URL}`, status: 401, json: { error: { message: "Invalid OAuth access token.", code: 190 } } }]);

    expect(await client.check()).toEqual({ ok: false, detail: "WhatsApp a refusé les identifiants : Invalid OAuth access token." });
  });
});

describe("sending a template", () => {
  it("posts the approved template with its body's parameters", async () => {
    const { client, calls } = whatsapp([{ match: `POST ${NUMBER_URL}/messages`, json: { messaging_product: "whatsapp", contacts: [{ input: "+33698765432", wa_id: "33698765432" }], messages: [{ id: "wamid.abc", message_status: "accepted" }] } }]);

    const sent = await client.sendTemplate({ to: "+33698765432", template: "premier_contact", language: "fr", parameters: ["Jeanne", "Northwind"] });

    expect(sent).toEqual({ externalId: "wamid.abc" });
    expect(calls[0].headers.get("authorization")).toBe("Bearer system-user-token");
    expect(calls[0].headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(calls[0].body)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "+33698765432",
      type: "template",
      template: {
        name: "premier_contact",
        language: { code: "fr" },
        components: [{ type: "body", parameters: [{ type: "text", text: "Jeanne" }, { type: "text", text: "Northwind" }] }],
      },
    });
  });

  it("sends no components for a template without parameters", async () => {
    const { client, calls } = whatsapp([{ match: `POST ${NUMBER_URL}/messages`, json: { messages: [{ id: "wamid.abc" }] } }]);

    await client.sendTemplate({ to: "+33698765432", template: "bonjour", language: "fr", parameters: [] });

    expect(JSON.parse(calls[0].body).template).toEqual({ name: "bonjour", language: { code: "fr" } });
  });

  it("throws what Meta refused", async () => {
    const { client } = whatsapp([{ match: `POST ${NUMBER_URL}/messages`, status: 400, json: { error: { message: "Template name does not exist" } } }]);

    await expect(client.sendTemplate({ to: "+33698765432", template: "x", language: "fr", parameters: [] })).rejects.toThrow("WhatsApp a refusé la demande : Template name does not exist");
  });
});

describe("Meta's handshake", () => {
  const handshake = { "hub.mode": "subscribe", "hub.verify_token": "hook-token", "hub.challenge": "1158201444" };

  it("answers the challenge as plain text when the verify token is the connection's hook token", async () => {
    const { signals, reply } = await whatsapp().client.readWebhook(get(handshake));

    expect(signals).toEqual([]);
    expect(reply?.status).toBe(200);
    expect(reply?.headers.get("content-type")).toBe("text/plain");
    expect(await reply?.text()).toBe("1158201444");
  });

  it("refuses another token, another mode, and a hook with no token", async () => {
    const refused = "Le jeton de vérification de WhatsApp ne correspond pas.";

    await expect(whatsapp().client.readWebhook(get({ ...handshake, "hub.verify_token": "wrong" }))).rejects.toThrow(refused);
    await expect(whatsapp().client.readWebhook(get({ ...handshake, "hub.mode": "unsubscribe" }))).rejects.toThrow(refused);
    await expect(whatsapp().client.readWebhook(get({ "hub.mode": "subscribe", "hub.challenge": "1" }))).rejects.toThrow(refused);

    const { fetch } = fakeFetch([]);
    const noToken = whatsappCloudAdapter(adapterContext(FIELDS, fetch, { hookUrl: "https://coldlyne.test/api/hooks/1" }));
    await expect(noToken.readWebhook(get(handshake))).rejects.toThrow(refused);
  });
});

describe("Meta's signature", () => {
  it("is checked against a known answer, made apart from this code", async () => {
    const body = '{"entry":[]}';

    const { signals } = await whatsapp().client.readWebhook(post(body, "sha256=fe6aaed5aff30b5679e782271914a2287bdd7de6bedb495c95c24ad91e5e3fdb"));

    expect(signals).toEqual([]);
  });

  it("covers the raw body, as received, accents included", async () => {
    const body = change({ messages: [{ id: "wamid.1", from: "33698765432", timestamp: "1793786400", type: "text", text: { body: "Très intéressé" } }] });

    expect((await whatsapp().client.readWebhook(post(body))).signals[0].detail).toBe("Très intéressé");
  });

  it("refuses a post forged, signed with another secret, changed or not signed", async () => {
    const body = change({ messages: [{ id: "wamid.1", from: "33698765432", type: "text", text: { body: "Oui" } }] });
    const refused = "Message non lu\u00A0: rien ne prouve qu’il a été envoyé par WhatsApp.";

    await expect(whatsapp().client.readWebhook(post(body, "sha256=00"))).rejects.toThrow(refused);
    await expect(whatsapp().client.readWebhook(post(body, sign(body, "another-secret")))).rejects.toThrow(refused);
    await expect(whatsapp().client.readWebhook(post(`${body} `, sign(body)))).rejects.toThrow(refused);
    await expect(whatsapp().client.readWebhook({ method: "POST", url: HOOK, headers: new Headers(), body })).rejects.toThrow(refused);
  });

  it("refuses a signed post it can't read", async () => {
    await expect(whatsapp().client.readWebhook(post("not json"))).rejects.toThrow("WhatsApp a envoyé un message illisible.");
  });
});

describe("incoming messages", () => {
  const read = async (message: Record<string, unknown>) => (await whatsapp().client.readWebhook(post(change({ contacts: [{ wa_id: "33698765432" }], messages: [{ id: "wamid.in", from: "33698765432", timestamp: "1793786400", ...message }] })))).signals;

  it("are replies, from the sender in E.164", async () => {
    expect(await read({ type: "text", text: { body: "Oui, appelez-moi" } })).toEqual([{ type: "replied", channel: "whatsapp", externalId: "wamid.in", address: "+33698765432", at: AT, detail: "Oui, appelez-moi" }]);
  });

  it.each(["STOP", "stop", " Stop ! ", "ARRET", "arrêt", "Arrêt."])("are an opt-out when the whole text is %j", async (text) => {
    expect((await read({ type: "text", text: { body: text } }))[0]).toMatchObject({ type: "opted_out", address: "+33698765432" });
  });

  it("aren't an opt-out for a sentence that merely has the word in it", async () => {
    expect((await read({ type: "text", text: { body: "Ne vous arrêtez pas, stop à la paperasse" } }))[0].type).toBe("replied");
  });

  it("read a template's button, and an interactive answer", async () => {
    expect((await read({ type: "button", button: { text: "STOP", payload: "STOP" } }))[0]).toMatchObject({ type: "opted_out", detail: "STOP" });
    expect((await read({ type: "button", button: { text: "Intéressé" } }))[0]).toMatchObject({ type: "replied", detail: "Intéressé" });
    expect((await read({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: "a", title: "Oui" } } }))[0]).toMatchObject({ type: "replied", detail: "Oui" });
    expect((await read({ type: "interactive", interactive: { type: "list_reply", list_reply: { id: "b", title: "Plus tard" } } }))[0]).toMatchObject({ type: "replied", detail: "Plus tard" });
  });

  it("are replies even with nothing to read, such as a photo", async () => {
    expect((await read({ type: "image", image: { id: "1" } }))[0]).toMatchObject({ type: "replied", detail: undefined });
  });

  it("keep only the first lines of a long reply", async () => {
    expect((await read({ type: "text", text: { body: "x".repeat(800) } }))[0].detail).toHaveLength(500);
  });

  it("have no address when the person's number can't be shared", async () => {
    expect((await read({ from: undefined, type: "text", text: { body: "Oui" } }))[0].address).toBeNull();
  });

  it("aren't WhatsApp's own notice that someone changed number", async () => {
    expect(await read({ type: "system", system: { type: "user_changed_number" } })).toEqual([]);
  });

  it("are dated now when Meta gave no timestamp", async () => {
    expect((await read({ timestamp: undefined, type: "text", text: { body: "Oui" } }))[0].at).toEqual(new Date("2026-11-04T09:00:00Z"));
  });
});

describe("statuses", () => {
  const read = async (status: Record<string, unknown>) => (await whatsapp().client.readWebhook(post(change({ statuses: [{ id: "wamid.out", recipient_id: "33698765432", timestamp: "1793786400", ...status }] })))).signals;

  it("are delivered, about the person it was sent to", async () => {
    expect(await read({ status: "delivered" })).toEqual([{ type: "delivered", channel: "whatsapp", externalId: "wamid.out:delivered", address: "+33698765432", at: AT, detail: undefined }]);
  });

  it("are failed, with Meta's reason", async () => {
    expect(await read({ status: "failed", errors: [{ code: 131026, title: "Message undeliverable", message: "Message undeliverable." }] })).toEqual([{ type: "failed", channel: "whatsapp", externalId: "wamid.out:failed", address: "+33698765432", at: AT, detail: "Message undeliverable." }]);
    expect((await read({ status: "failed", errors: [{ code: 131049, title: "Not delivered" }] }))[0].detail).toBe("Not delivered");
    expect((await read({ status: "failed" }))[0]).toMatchObject({ type: "failed", detail: undefined });
  });

  it("are an opt-out when the person stopped this business's marketing messages", async () => {
    expect((await read({ status: "failed", errors: [{ code: 131050, title: "Unable to deliver the message." }] }))[0].type).toBe("opted_out");
  });

  it("say nothing when merely sent or read", async () => {
    expect(await read({ status: "sent" })).toEqual([]);
    expect(await read({ status: "read" })).toEqual([]);
    expect(await read({ status: "played" })).toEqual([]);
  });
});

describe("marketing preferences", () => {
  const read = async (preference: Record<string, unknown>) => (await whatsapp().client.readWebhook(post(change({ user_preferences: [{ wa_id: "33698765432", category: "marketing_messages", timestamp: 1793786400, ...preference }] })))).signals;

  it("are an opt-out when the person stops them", async () => {
    expect(await read({ value: "stop", detail: "User requested to stop marketing messages" })).toEqual([{ type: "opted_out", channel: "whatsapp", externalId: "preferences:33698765432:1793786400", address: "+33698765432", at: AT }]);
  });

  it("say nothing when the person resumes them: an opt-out stays until they ask", async () => {
    expect(await read({ value: "resume" })).toEqual([]);
  });
});

describe("a post with several things in it", () => {
  it("gives them all, across entries and changes", async () => {
    const body = JSON.stringify({
      entry: [
        { changes: [{ value: { messages: [{ id: "a", from: "33600000001", type: "text", text: { body: "Oui" } }] } }, { value: { statuses: [{ id: "b", status: "delivered", recipient_id: "33600000002" }] } }] },
        { changes: [{ value: { messages: [{ id: "c", from: "33600000003", type: "text", text: { body: "STOP" } }] } }, {}] },
        {},
      ],
    });

    expect((await whatsapp().client.readWebhook(post(body))).signals.map((signal) => [signal.type, signal.address])).toEqual([
      ["replied", "+33600000001"],
      ["delivered", "+33600000002"],
      ["opted_out", "+33600000003"],
    ]);
  });

  it("leaves out the business account's other numbers", async () => {
    const body = change({ metadata: { phone_number_id: "another" }, messages: [{ id: "a", from: "33600000001", type: "text", text: { body: "Oui" } }] });

    expect((await whatsapp().client.readWebhook(post(body))).signals).toEqual([]);
  });

  it("gives nothing when there is nothing in it", async () => {
    expect((await whatsapp().client.readWebhook(post("{}"))).signals).toEqual([]);
  });
});
