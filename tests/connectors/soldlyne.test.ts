import { describe, expect, it } from "vitest";
import type { CrmContact } from "@/application/ports";
import { crmAdapters } from "@/infrastructure/connectors/crm";
import { adapterContext, fakeFetch, type FakeRoute } from "../support/fetch";

const ADDRESS = "https://crm.acme.example";
const FIELDS = { address: `${ADDRESS}/`, apiKey: "sl_secret-key" };
const WORKSPACE = `GET ${ADDRESS}/api/v1/workspace`;
const OFF_LIMITS = `GET ${ADDRESS}/api/v1/do-not-prospect`;
const HANDOVERS = `POST ${ADDRESS}/api/v1/handovers`;

const JEANNE: CrmContact = {
  firstName: "Jeanne",
  lastName: "Martin",
  email: "jeanne@northwind.example",
  phone: "+33612345678",
  role: "Présidente",
  company: { name: "NORTHWIND", siren: "732829320", website: "https://www.northwind.example" },
  note: "A répondu par Email : volontiers.",
  channel: "email",
};

function client(routes: FakeRoute[], fields: Record<string, string> = FIELDS) {
  const { fetch, calls } = fakeFetch(routes);
  return { adapter: crmAdapters.soldlyne(adapterContext(fields, fetch)), calls };
}

describe("Soldlyne", () => {
  it("is named after the workspace its key opens, with the key in a bearer header", async () => {
    const { adapter, calls } = client([
      { match: WORKSPACE, json: { id: "w1", name: "Northwind", handoverVersion: 2 } },
      { match: OFF_LIMITS, json: { data: [], nextCursor: null, asOf: "2026-11-07T00:00:00.000Z" } },
    ]);
    expect(await adapter.check()).toEqual({ ok: true, detail: "compte «\u00a0Northwind\u00a0»", label: "Northwind" });
    expect(calls[0].headers.get("authorization")).toBe("Bearer sl_secret-key");
  });

  it("says what to do with a key that only reads, rather than connecting and failing later", async () => {
    const { adapter } = client([
      { match: WORKSPACE, json: { id: "w1", name: "Northwind", handoverVersion: 2 } },
      { match: OFF_LIMITS, status: 403, json: { error: "This key can't hand anyone over." } },
    ]);
    const checked = await adapter.check();
    expect(checked.ok).toBe(false);
    expect(checked.detail).toContain("clé pour Coldlyne");
  });

  it.each([[undefined], [1]])("refuses an install on handover version %s, which would bring back people deleted there, and asks it nothing more", async (handoverVersion) => {
    const { adapter, calls } = client([{ match: WORKSPACE, json: { id: "w1", name: "Northwind", handoverVersion } }]);
    const checked = await adapter.check();
    expect(checked.ok).toBe(false);
    expect(checked.detail).toContain("mettez-la à jour");
    expect(checked.detail).toContain("supprimées");
    expect(calls).toHaveLength(1);
  });

  it("takes a later handover version", async () => {
    const { adapter } = client([
      { match: WORKSPACE, json: { id: "w1", name: "Northwind", handoverVersion: 3 } },
      { match: OFF_LIMITS, json: { data: [], nextCursor: null, asOf: "x" } },
    ]);
    expect((await adapter.check()).ok).toBe(true);
  });

  it("says when the key is refused", async () => {
    const { adapter } = client([{ match: WORKSPACE, status: 401, json: { error: "A valid API key is required" } }]);
    expect(await adapter.check()).toEqual({ ok: false, detail: expect.stringContaining("Soldlyne a refusé les identifiants") });
  });

  it.each(["http://crm.acme.example", "https://localhost", "https://10.0.0.8", "https://169.254.169.254", "https://crm.internal", "pas une adresse"])("sends the key nowhere but a public https address, so not to %s", async (address) => {
    const { adapter, calls } = client([], { address, apiKey: "sl_secret-key" });
    const checked = await adapter.check();
    expect(checked.ok).toBe(false);
    expect(checked.detail).toContain("https");
    await expect(adapter.pushContact!(JEANNE)).rejects.toThrow("https");
    await expect(adapter.offLimits!()).rejects.toThrow("https");
    expect(calls).toEqual([]);
  });

  it("keeps the key from following a redirect to another host", async () => {
    let redirect: RequestRedirect | undefined;
    const fetchSpy = (async (_url: RequestInfo | URL, init: RequestInit = {}) => {
      redirect = init.redirect;
      return new Response(JSON.stringify({ dealId: "d1" }));
    }) as typeof fetch;
    await crmAdapters.soldlyne(adapterContext(FIELDS, fetchSpy)).pushContact!(JEANNE);
    expect(redirect).toBe("error");
  });

  it("hands someone over: company, person, what happened and through which channel, and gives the deal as its id", async () => {
    const { adapter, calls } = client([{ match: HANDOVERS, status: 201, json: { dealId: "d1", personId: "p1", companyId: "c1", created: true } }]);
    expect(await adapter.pushContact!(JEANNE)).toEqual({ externalId: "d1" });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].body)).toEqual({
      company: { name: "NORTHWIND", website: "https://www.northwind.example", siren: "732829320" },
      person: { firstName: "Jeanne", lastName: "Martin", email: "jeanne@northwind.example", phone: "+33612345678", jobTitle: "Présidente" },
      note: "A répondu par Email : volontiers.",
      source: "EMAIL",
    });
  });

  it("hears that someone was deleted there as nothing to hand over, with no id and no error", async () => {
    const { adapter } = client([{ match: HANDOVERS, status: 409, json: { error: "person_deleted" } }]);
    expect(await adapter.pushContact!(JEANNE)).toEqual({ externalId: null });
  });

  it.each(["The product this key opens deals on is gone: make a new key in Settings.", "This workspace has no open stage to put a deal in."])("takes any other 409 for the trouble it is: %s", async (error) => {
    const { adapter } = client([{ match: HANDOVERS, status: 409, json: { error } }]);
    await expect(adapter.pushContact!(JEANNE)).rejects.toThrow(error);
  });

  it("sends only what it knows, within what Soldlyne takes", async () => {
    const { adapter, calls } = client([{ match: HANDOVERS, json: { dealId: "d1" } }]);
    await adapter.pushContact!({ firstName: null, lastName: "Martin", email: null, phone: null, role: null, company: { name: "X".repeat(300), siren: null, website: null }, note: "" });
    expect(JSON.parse(calls[0].body)).toEqual({ company: { name: "X".repeat(200) }, person: { lastName: "Martin" }, source: "OTHER" });
  });

  it.each([["call", "PHONE"], ["sms", "PHONE"], ["whatsapp", "PHONE"], ["voicemail", "PHONE"], ["linkedin", "LINKEDIN"], ["instagram", "SOCIAL"], ["messenger", "SOCIAL"], ["x", "SOCIAL"], ["letter", "OTHER"]] as const)("says a reply by %s came through %s", async (channel, source) => {
    const { adapter, calls } = client([{ match: HANDOVERS, json: { dealId: "d1" } }]);
    await adapter.pushContact!({ ...JEANNE, channel });
    expect(JSON.parse(calls[0].body).source).toBe(source);
  });

  it("reads everyone off limits, page after page", async () => {
    const page = (name: string, nextCursor: string | null) => ({ data: [{ why: "customer", company: { name, domain: null, siren: null }, people: [] }], nextCursor, asOf: "x" });
    const { adapter, calls } = client([
      { match: `${OFF_LIMITS}?limit=200&cursor=a%2Fb`, json: page("Second", null) },
      { match: `${OFF_LIMITS}?limit=200`, json: page("First", "a/b") },
    ]);
    expect((await adapter.offLimits!()).map((entry) => entry.company?.name)).toEqual(["First", "Second"]);
    expect(calls).toHaveLength(2);
  });

  it("gives up on an answer it can't read, or that never ends, rather than read for ever", async () => {
    const unreadable = client([{ match: OFF_LIMITS, json: { data: [{ company: "nope" }] } }]);
    await expect(unreadable.adapter.offLimits!()).rejects.toThrow();
    const endless = client([{ match: OFF_LIMITS, json: { data: [], nextCursor: "again", asOf: "x" } }]);
    await expect(endless.adapter.offLimits!()).rejects.toThrow("ne finit pas");
    expect(endless.calls.length).toBeLessThanOrEqual(1000);
  });
});
