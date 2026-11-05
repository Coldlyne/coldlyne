import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { InboundRequest } from "@/application/ports";
import { automationAdapters } from "@/infrastructure/connectors/automation";
import { signColdlyne, verifyColdlyneSignature } from "@/infrastructure/connectors/automation/webhook";
import { sha256 } from "@/infrastructure/crypto/secrets";
import { adapterContext, fakeFetch } from "../support/fetch";

const NOW = new Date("2026-11-04T09:00:00Z");
const REPLIED = { event: "replied", title: "Jeanne Dupont-Martin a répondu", text: "Intéressée, rappeler jeudi.", url: "https://coldlyne.test/replies/1" } as const;

describe("Slack", () => {
  const HOOK = "https://hooks.slack.com/services/T0/B0/fixture";

  it("posts the notification, with a link to where it is in Coldlyne", async () => {
    const { fetch, calls } = fakeFetch([{ match: `POST ${HOOK}`, text: "ok" }]);

    await automationAdapters.slack(adapterContext({ webhookUrl: HOOK }, fetch)).notify?.(REPLIED);

    expect(calls[0].headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(calls[0].body)).toEqual({ text: "*Jeanne Dupont-Martin a répondu*\nIntéressée, rappeler jeudi.\n<https://coldlyne.test/replies/1|Voir dans Coldlyne>" });
  });

  it("leaves the link out when there is none, and escapes what Slack would read as its own", async () => {
    const { fetch, calls } = fakeFetch([{ match: `POST ${HOOK}`, text: "ok" }]);

    await automationAdapters.slack(adapterContext({ webhookUrl: HOOK }, fetch)).notify?.({ event: "test", title: "A & B", text: "<!channel> > tous" });

    expect(JSON.parse(calls[0].body)).toEqual({ text: "*A &amp; B*\n&lt;!channel&gt; &gt; tous" });
  });

  it("says when Slack refuses a message", async () => {
    const { fetch } = fakeFetch([{ match: `POST ${HOOK}`, status: 404, text: "no_service" }]);

    await expect(automationAdapters.slack(adapterContext({ webhookUrl: HOOK }, fetch)).notify?.(REPLIED)).rejects.toThrow("Slack ne trouve pas ce qui est demandé : no_service");
  });

  it("checks the address's shape and posts nothing", async () => {
    const { fetch, calls } = fakeFetch([]);

    expect(await automationAdapters.slack(adapterContext({ webhookUrl: HOOK }, fetch)).check()).toEqual({ ok: true, detail: "vérifié au premier envoi", label: "Webhook Slack" });
    expect(calls).toEqual([]);
  });

  it("refuses any other address, at the check and when sending, since the address carries the secret", async () => {
    const { fetch, calls } = fakeFetch([]);
    const adapter = automationAdapters.slack(adapterContext({ webhookUrl: "https://evil.example/services/T0/B0/X" }, fetch));

    expect(await adapter.check()).toMatchObject({ ok: false, detail: expect.stringContaining("webhook entrant Slack") });
    await expect(adapter.notify?.(REPLIED)).rejects.toThrow("webhook entrant Slack");
    expect(calls).toEqual([]);
  });
});

describe("the outgoing webhook", () => {
  const HOOK = "https://n8n.northwind.fr/webhook/coldlyne";

  it("posts each notification as JSON, signed with the token of the connection's address", async () => {
    const { fetch, calls } = fakeFetch([{ match: `POST ${HOOK}`, text: "Workflow was started" }]);

    await automationAdapters.webhook(adapterContext({ url: HOOK }, fetch)).notify?.(REPLIED);

    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].body)).toEqual({ ...REPLIED, at: "2026-11-04T09:00:00.000Z" });
    expect(calls[0].headers.get("content-type")).toBe("application/json");
    const expected = createHmac("sha256", "hook-token").update(`1793782800.${calls[0].body}`).digest("hex");
    expect(calls[0].headers.get("coldlyne-signature")).toBe(`t=1793782800,v1=${expected}`);
  });

  it("checks the receiver with a test event, and says when it refuses", async () => {
    const accepted = fakeFetch([{ match: `POST ${HOOK}`, json: { ok: true } }]);
    expect(await automationAdapters.webhook(adapterContext({ url: HOOK }, accepted.fetch)).check()).toEqual({ ok: true, detail: "événement de test reçu", label: "n8n.northwind.fr" });
    expect(JSON.parse(accepted.calls[0].body)).toMatchObject({ event: "test", url: null });

    const refused = fakeFetch([{ match: `POST ${HOOK}`, status: 404, text: "The requested webhook is not registered." }]);
    expect(await automationAdapters.webhook(adapterContext({ url: HOOK }, refused.fetch)).check()).toEqual({
      ok: false,
      detail: "Le webhook ne trouve pas ce qui est demandé : The requested webhook is not registered.",
    });
  });
});

describe("the outgoing webhook's address", () => {
  it("must be public and encrypted: nothing is sent to a local or plain address", async () => {
    const { fetch, calls } = fakeFetch([]);

    for (const url of ["http://n8n.northwind.fr/webhook", "https://localhost/hook", "https://127.0.0.1/hook", "https://2130706433/hook", "https://10.0.0.8/hook", "https://169.254.169.254/latest", "https://172.20.1.1/hook", "https://192.168.1.2/hook", "https://[::1]/hook", "pas une adresse"]) {
      expect(await automationAdapters.webhook(adapterContext({ url }, fetch)).check()).toEqual({ ok: false, detail: "L’adresse du webhook doit être une adresse https publique." });
    }
    expect(calls).toEqual([]);
  });

  it("isn't left by following a redirect", async () => {
    const hook = "https://n8n.northwind.fr/webhook";
    const { fetch: answer } = fakeFetch([{ match: `POST ${hook}`, status: 302, text: "" }]);
    const asked: RequestInit[] = [];
    const remembering = ((url: string, init: RequestInit) => {
      asked.push(init);
      return answer(url, init);
    }) as typeof fetch;

    expect(await automationAdapters.webhook(adapterContext({ url: hook }, remembering)).check()).toEqual({ ok: false, detail: "Le webhook a répondu 302." });
    expect(asked[0].redirect).toBe("manual");
  });
});

describe("a receiver checking Coldlyne's signature", () => {
  const body = JSON.stringify({ ...REPLIED, at: NOW.toISOString() });
  const header = signColdlyne(body, "hook-token", NOW);

  it("accepts a body signed with the secret, within five minutes", () => {
    expect(verifyColdlyneSignature(body, header, "hook-token", new Date(NOW.getTime() + 299_000))).toBe(true);
  });

  it("refuses a body changed after signing, another secret, or a mangled header", () => {
    expect(verifyColdlyneSignature(body.replace("jeudi", "lundi"), header, "hook-token", NOW)).toBe(false);
    expect(verifyColdlyneSignature(body, header, "another-token", NOW)).toBe(false);
    expect(verifyColdlyneSignature(body, header.replace(/v1=\w+/, "v1=00"), "hook-token", NOW)).toBe(false);
    expect(verifyColdlyneSignature(body, "v1=abc", "hook-token", NOW)).toBe(false);
  });

  it("refuses a call replayed later than the tolerance", () => {
    expect(verifyColdlyneSignature(body, header, "hook-token", new Date(NOW.getTime() + 301_000))).toBe(false);
    expect(verifyColdlyneSignature(body, header, "hook-token", new Date(NOW.getTime() + 3_600_000), 7_200)).toBe(true);
  });
});

describe("sign-ups from the business's site", () => {
  const reader = automationAdapters.signups(adapterContext({}, fakeFetch([]).fetch));
  const posted = (body: string, type: string): InboundRequest => ({ method: "POST", url: "https://coldlyne.test/api/hooks/x?token=hook-token", headers: new Headers({ "content-type": type }), body });

  it("reads a JSON sign-up with its date and id", async () => {
    const { signals } = await reader.readWebhook!(posted(JSON.stringify({ email: " Jeanne@Northwind.FR ", at: "2026-11-03T18:30:00+01:00", id: "user_42" }), "application/json"));

    expect(signals).toEqual([{ type: "signed_up", channel: "site", externalId: "user_42", address: "jeanne@northwind.fr", at: new Date("2026-11-03T17:30:00Z") }]);
  });

  it("reads a form's email, dated now, with an id that counts the same address once a day", async () => {
    const { signals } = await reader.readWebhook!(posted("email=jeanne%40northwind.fr", "application/x-www-form-urlencoded"));

    expect(signals).toEqual([{ type: "signed_up", channel: "site", externalId: sha256("jeanne@northwind.fr:2026-11-04"), address: "jeanne@northwind.fr", at: NOW }]);
  });

  it("refuses a missing or invalid address, an unreadable body or date, and anything but a POST", async () => {
    await expect(reader.readWebhook!(posted(JSON.stringify({ email: "jeanne" }), "application/json"))).rejects.toThrow("L’adresse email de l’inscription manque ou n’est pas valide.");
    await expect(reader.readWebhook!(posted("name=Jeanne", "application/x-www-form-urlencoded"))).rejects.toThrow("L’adresse email de l’inscription manque ou n’est pas valide.");
    await expect(reader.readWebhook!(posted("{email:", "application/json"))).rejects.toThrow("Le corps de la demande n’est pas un objet JSON lisible.");
    await expect(reader.readWebhook!(posted(JSON.stringify({ email: "jeanne@northwind.fr", at: "hier" }), "application/json"))).rejects.toThrow("n’est pas une date ISO 8601");
    await expect(reader.readWebhook!({ ...posted("email=jeanne%40northwind.fr", "application/x-www-form-urlencoded"), method: "GET" })).rejects.toThrow("Les inscriptions s’envoient en POST.");
  });

  it("is ready as soon as it exists", async () => {
    expect(await reader.check()).toEqual({ ok: true, detail: "Prêt à recevoir les inscriptions de votre site.", label: "Inscriptions" });
  });
});
