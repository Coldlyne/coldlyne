import { describe, expect, it } from "vitest";
import type { CrmContact } from "@/application/ports";
import type { AdapterContext } from "@/infrastructure/connectors/adapter";
import { crmAdapters } from "@/infrastructure/connectors/crm";
import { adapterContext, fakeFetch, type FakeRoute, type RecordedCall } from "../support/fetch";

const JEANNE: CrmContact = {
  firstName: "Jeanne",
  lastName: "Dupont-Martin",
  email: "jeanne@acme.fr",
  phone: "+33612345678",
  role: "Présidente",
  company: { name: "ACME HOLDING", siren: "900000001", website: "https://www.acme.fr/contact" },
  note: "A répondu à l’email 2 : intéressée.",
};
const WITHOUT_EMAIL: CrmContact = { ...JEANNE, email: null };

/** The calls as "METHOD url" and their JSON body, to compare whole conversations with a CRM. */
const sent = (calls: RecordedCall[]) => calls.map(({ method, url, body }) => [`${method} ${url}`, ...(body ? [JSON.parse(body)] : [])]);

function client(kind: string, fields: Record<string, string>, routes: FakeRoute[], overrides: Partial<AdapterContext> = {}) {
  const { fetch, calls } = fakeFetch(routes);
  return { adapter: crmAdapters[kind](adapterContext(fields, fetch, overrides)), calls };
}

describe("HubSpot", () => {
  const API = "https://api.hubapi.com";
  const FIELDS = { accessToken: "pat-eu1-secret" };
  const COMPANIES = `${API}/crm/v3/objects/companies`;
  const CONTACTS = `${API}/crm/v3/objects/contacts`;
  const NOTE = {
    properties: { hs_timestamp: "2026-11-04T09:00:00.000Z", hs_note_body: JEANNE.note },
    associations: [{ to: { id: "501" }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] }],
  };
  const PROPERTIES = { email: "jeanne@acme.fr", firstname: "Jeanne", lastname: "Dupont-Martin", phone: "+33612345678", jobtitle: "Présidente", company: "ACME HOLDING" };
  const search = (property: string, value: string, properties: string[] = []) => ({ filterGroups: [{ filters: [{ propertyName: property, operator: "EQ", value }] }], properties, limit: 1 });
  const REST: FakeRoute[] = [
    { match: `PATCH ${API}/crm/v3/objects`, json: {} },
    { match: `PUT ${API}/crm/v4/objects/contact/501/associations/default/company/301`, json: {} },
    { match: `POST ${API}/crm/v3/objects/notes`, json: { id: "901" } },
  ];

  it("names the connection after the portal, with the token in a bearer header", async () => {
    const { adapter, calls } = client("hubspot", FIELDS, [{ match: `GET ${API}/account-info/v3/details`, json: { portalId: 123, portalName: "Northwind" } }]);

    expect(await adapter.check()).toEqual({ ok: true, detail: "compte « Northwind »", label: "Northwind" });
    expect(calls[0].headers.get("authorization")).toBe("Bearer pat-eu1-secret");
  });

  it("falls back on the portal's number, and says when the token is refused", async () => {
    const unnamed = client("hubspot", FIELDS, [{ match: `GET ${API}/account-info/v3/details`, json: { portalId: 123 } }]);
    expect(await unnamed.adapter.check()).toMatchObject({ ok: true, label: "Portail 123" });

    const refused = client("hubspot", FIELDS, [{ match: `GET ${API}/account-info/v3/details`, status: 401, json: { message: "Invalid token" } }]);
    expect(await refused.adapter.check()).toEqual({ ok: false, detail: "HubSpot a refusé les identifiants : Invalid token" });
  });

  it("adds no note when there's nothing to add", async () => {
    const { adapter, calls } = client("hubspot", FIELDS, [
      { match: `POST ${COMPANIES}/search`, json: { results: [] } },
      { match: `POST ${CONTACTS}/search`, json: { results: [] } },
      { match: `POST ${COMPANIES}`, json: { id: "301" } },
      { match: `POST ${CONTACTS}`, json: { id: "501" } },
      { match: `PUT ${API}/crm/v4/objects/contact/501/associations/default/company/301`, json: {} },
    ]);
    await adapter.pushContact!({ ...JEANNE, note: "" });
    expect(calls.map((call) => call.url)).not.toContain(`${API}/crm/v3/objects/notes`);
  });

  it("creates a new person and company, links them and adds the note", async () => {
    const { adapter, calls } = client("hubspot", FIELDS, [
      { match: `POST ${COMPANIES}/search`, json: { results: [] } },
      { match: `POST ${CONTACTS}/search`, json: { results: [] } },
      { match: `POST ${COMPANIES}`, json: { id: "301" } },
      { match: `POST ${CONTACTS}`, json: { id: "501" } },
      ...REST,
    ]);

    expect(await adapter.pushContact?.(JEANNE)).toEqual({ externalId: "501" });
    expect(sent(calls)).toEqual([
      [`POST ${COMPANIES}/search`, search("domain", "acme.fr", ["domain"])],
      [`POST ${COMPANIES}/search`, search("name", "ACME HOLDING", ["domain"])],
      [`POST ${COMPANIES}`, { properties: { name: "ACME HOLDING", domain: "acme.fr" } }],
      [`POST ${CONTACTS}/search`, search("email", "jeanne@acme.fr")],
      [`POST ${CONTACTS}`, { properties: PROPERTIES }],
      [`PUT ${API}/crm/v4/objects/contact/501/associations/default/company/301`],
      [`POST ${API}/crm/v3/objects/notes`, NOTE],
    ]);
  });

  it("updates a person already there, and leaves a company with its domain as it is", async () => {
    const { adapter, calls } = client("hubspot", FIELDS, [
      { match: `POST ${COMPANIES}/search`, json: { results: [{ id: "301", properties: { domain: "acme.fr" } }] } },
      { match: `POST ${CONTACTS}/search`, json: { results: [{ id: "501", properties: {} }] } },
      ...REST,
    ]);

    expect(await adapter.pushContact?.(JEANNE)).toEqual({ externalId: "501" });
    expect(sent(calls)).toEqual([
      [`POST ${COMPANIES}/search`, search("domain", "acme.fr", ["domain"])],
      [`POST ${CONTACTS}/search`, search("email", "jeanne@acme.fr")],
      [`PATCH ${CONTACTS}/501`, { properties: PROPERTIES }],
      [`PUT ${API}/crm/v4/objects/contact/501/associations/default/company/301`],
      [`POST ${API}/crm/v3/objects/notes`, NOTE],
    ]);
  });

  it("fills in a company's missing domain, and finds a person without an address by name and company", async () => {
    const { adapter, calls } = client("hubspot", FIELDS, [
      { match: `POST ${COMPANIES}/search`, json: { results: [{ id: "301", properties: { domain: null } }] } },
      { match: `POST ${CONTACTS}/search`, json: { results: [{ id: "501", properties: {} }] } },
      ...REST,
    ]);

    await adapter.pushContact?.(WITHOUT_EMAIL);

    expect(sent(calls)[1]).toEqual([`PATCH ${COMPANIES}/301`, { properties: { domain: "acme.fr" } }]);
    expect(JSON.parse(calls[2].body).filterGroups[0].filters).toEqual([
      { propertyName: "firstname", operator: "EQ", value: "Jeanne" },
      { propertyName: "lastname", operator: "EQ", value: "Dupont-Martin" },
      { propertyName: "company", operator: "EQ", value: "ACME HOLDING" },
    ]);
  });
});

describe("Pipedrive", () => {
  const API = "https://northwind.pipedrive.com";
  const FIELDS = { companyDomain: "northwind", apiToken: "pd-secret" };
  const FIND_COMPANY = `${API}/api/v2/organizations/search?term=ACME%20HOLDING&fields=name&exact_match=true&limit=1`;
  const FIND_PERSON = `${API}/api/v2/persons/search?term=jeanne%40acme.fr&fields=email&exact_match=true&limit=1`;
  const NOTE = { content: "A répondu à l’email 2 : intéressée.", person_id: 501 };
  const REST: FakeRoute[] = [
    { match: `POST ${API}/api/v2/organizations`, json: { data: { id: 301 } } },
    { match: `POST ${API}/api/v2/persons`, json: { data: { id: 501 } } },
    { match: `PATCH ${API}/api/v2`, json: { data: {} } },
    { match: `POST ${API}/api/v1/notes`, json: { data: { id: 901 } } },
  ];

  it("names the connection after the company, with the token in its header", async () => {
    const { adapter, calls } = client("pipedrive", FIELDS, [{ match: `GET ${API}/api/v1/users/me`, json: { data: { name: "Marie", company_name: "Northwind" } } }]);

    expect(await adapter.check()).toEqual({ ok: true, detail: "compte « Northwind »", label: "Northwind" });
    expect(calls[0].headers.get("x-api-token")).toBe("pd-secret");
  });

  it("says when the token is refused", async () => {
    const { adapter } = client("pipedrive", FIELDS, [{ match: `GET ${API}/api/v1/users/me`, status: 401, json: { success: false, error: "unauthorized access" } }]);

    expect(await adapter.check()).toEqual({ ok: false, detail: "Pipedrive a refusé les identifiants : unauthorized access" });
  });

  it("refuses a subdomain that would send the token elsewhere, without calling anyone", async () => {
    const { adapter, calls } = client("pipedrive", { ...FIELDS, companyDomain: "evil.example/x#" }, []);

    expect(await adapter.check()).toMatchObject({ ok: false, detail: expect.stringContaining("Le sous-domaine Pipedrive") });
    expect(calls).toEqual([]);
  });

  it("creates a new person and organization, and adds the note as escaped HTML", async () => {
    const { adapter, calls } = client("pipedrive", FIELDS, [
      { match: `GET ${API}/api/v2/organizations/search`, json: { data: { items: [] } } },
      { match: `GET ${API}/api/v2/persons/search`, json: { data: { items: [] } } },
      ...REST,
    ]);

    expect(await adapter.pushContact?.({ ...JEANNE, note: "Budget < 5 k€ & pressé" })).toEqual({ externalId: "501" });
    expect(sent(calls)).toEqual([
      [`GET ${FIND_COMPANY}`],
      [`POST ${API}/api/v2/organizations`, { name: "ACME HOLDING", website: "https://www.acme.fr/contact" }],
      [`GET ${FIND_PERSON}`],
      [`POST ${API}/api/v2/persons`, { name: "Jeanne Dupont-Martin", org_id: 301, emails: [{ value: "jeanne@acme.fr" }], phones: [{ value: "+33612345678" }] }],
      [`POST ${API}/api/v1/notes`, { content: "Budget &lt; 5 k€ &amp; pressé", person_id: 501 }],
    ]);
  });

  it("updates a person already there, keeping their other numbers and writing no list that hasn't changed", async () => {
    const { adapter, calls } = client("pipedrive", FIELDS, [
      { match: `GET ${API}/api/v2/organizations/search`, json: { data: { items: [{ item: { id: 301 } }] } } },
      { match: `GET ${API}/api/v2/persons/search`, json: { data: { items: [{ item: { id: 501, emails: ["jeanne@acme.fr"], phones: ["+33 1 23 45 67 89"] } }] } } },
      ...REST,
    ]);

    expect(await adapter.pushContact?.(JEANNE)).toEqual({ externalId: "501" });
    expect(sent(calls)).toEqual([
      [`GET ${FIND_COMPANY}`],
      [`PATCH ${API}/api/v2/organizations/301`, { website: "https://www.acme.fr/contact" }],
      [`GET ${FIND_PERSON}`],
      [`PATCH ${API}/api/v2/persons/501`, { name: "Jeanne Dupont-Martin", org_id: 301, phones: [{ value: "+33 1 23 45 67 89" }, { value: "+33612345678" }] }],
      [`POST ${API}/api/v1/notes`, NOTE],
    ]);
  });

  it("finds a person without an address by name within the organization", async () => {
    const { adapter, calls } = client("pipedrive", FIELDS, [
      { match: `GET ${API}/api/v2/organizations/search`, json: { data: { items: [{ item: { id: 301 } }] } } },
      { match: `GET ${API}/api/v2/persons/search`, json: { data: { items: [] } } },
      ...REST,
    ]);

    await adapter.pushContact?.(WITHOUT_EMAIL);

    expect(calls[2].url).toBe(`${API}/api/v2/persons/search?term=Jeanne%20Dupont-Martin&fields=name&exact_match=true&limit=1&organization_id=301`);
  });
});

describe("Sellsy", () => {
  const API = "https://api.sellsy.com/v2";
  const TOKEN = "https://login.sellsy.com/oauth2/access-tokens";
  const FIELDS = { clientId: "client-id", clientSecret: "client-secret" };
  const TOKEN_ROUTE: FakeRoute = { match: `POST ${TOKEN}`, json: { token_type: "Bearer", expires_in: 3600, access_token: "sellsy-token" } };
  const STAFF_ROUTE: FakeRoute = { match: `GET ${API}/staffs/me`, json: { firstname: "Marie", lastname: "Durand", _embed: { account: { name: "Northwind" } } } };
  const NOTE = { description: JEANNE.note, related: [{ type: "contact", id: 501 }] };
  const WRITES: FakeRoute[] = [
    { match: `POST ${API}/companies/301/contacts/501`, json: {} },
    { match: `POST ${API}/companies`, json: { id: 301 } },
    { match: `POST ${API}/contacts`, json: { id: 501 } },
    { match: `PUT ${API}/`, json: {} },
    { match: `POST ${API}/comments`, json: { id: 901 } },
  ];
  const withoutToken = (calls: RecordedCall[]) => sent(calls.filter((call) => call.url !== TOKEN));

  it("gets a token, then names the connection after the account", async () => {
    const { adapter, calls } = client("sellsy", FIELDS, [TOKEN_ROUTE, STAFF_ROUTE]);

    expect(await adapter.check()).toEqual({ ok: true, detail: "compte « Northwind »", label: "Northwind" });
    expect(sent(calls)).toEqual([[`POST ${TOKEN}`, { grant_type: "client_credentials", client_id: "client-id", client_secret: "client-secret" }], [`GET ${API}/staffs/me?embed[]=account`]]);
    expect(calls[0].headers.get("content-type")).toBe("application/json");
    expect(calls[1].headers.get("authorization")).toBe("Bearer sellsy-token");
  });

  it("falls back on the staff member's name when the account is hidden, and says when the client is refused", async () => {
    const hidden = client("sellsy", FIELDS, [TOKEN_ROUTE, { match: `GET ${API}/staffs/me`, json: { firstname: "Marie", lastname: "Durand" } }]);
    expect(await hidden.adapter.check()).toMatchObject({ ok: true, label: "Marie Durand" });

    const refused = client("sellsy", FIELDS, [{ match: `POST ${TOKEN}`, status: 401, json: { error: "invalid_client", error_description: "Client authentication failed" } }]);
    expect(await refused.adapter.check()).toEqual({ ok: false, detail: "Sellsy a refusé les identifiants : Client authentication failed" });
  });

  it("keeps a token until it nears its end, then asks for another", async () => {
    let now = new Date("2026-11-04T09:00:00Z");
    const { adapter, calls } = client("sellsy", FIELDS, [TOKEN_ROUTE, STAFF_ROUTE], { now: () => now });

    await adapter.check();
    now = new Date("2026-11-04T09:58:00Z");
    await adapter.check();
    now = new Date("2026-11-04T09:59:30Z");
    await adapter.check();

    expect(calls.filter((call) => call.url === TOKEN)).toHaveLength(2);
  });

  it("creates a new contact and prospect company, links them and adds the comment", async () => {
    const { adapter, calls } = client("sellsy", FIELDS, [
      TOKEN_ROUTE,
      { match: `POST ${API}/companies/search`, json: { data: [] } },
      { match: `POST ${API}/contacts/search`, json: { data: [] } },
      ...WRITES,
    ]);

    expect(await adapter.pushContact?.(JEANNE)).toEqual({ externalId: "501" });
    expect(calls.filter((call) => call.url === TOKEN)).toHaveLength(1);
    expect(withoutToken(calls)).toEqual([
      [`POST ${API}/companies/search`, { filters: { name: "ACME HOLDING" } }],
      [`POST ${API}/companies`, { type: "prospect", name: "ACME HOLDING", website: "https://www.acme.fr/contact", legal_france: { siren: "900000001" } }],
      [`POST ${API}/contacts/search`, { filters: { email: "jeanne@acme.fr" } }],
      [`POST ${API}/contacts`, { first_name: "Jeanne", last_name: "Dupont-Martin", email: "jeanne@acme.fr", phone_number: "+33612345678", position: "Présidente" }],
      [`POST ${API}/companies/301/contacts/501`],
      [`POST ${API}/comments`, NOTE],
    ]);
  });

  it("updates a contact already there, sending back the fields it already has", async () => {
    const { adapter, calls } = client("sellsy", FIELDS, [
      TOKEN_ROUTE,
      { match: `POST ${API}/companies/search`, json: { data: [{ id: 301, name: "ACME HOLDING", website: "https://acme.fr", legal_france: { siren: "900000001" } }] } },
      { match: `POST ${API}/contacts/search`, json: { data: [{ id: 501, civility: "mrs", first_name: "Jeanne", last_name: "Dupont-Martin", email: "jeanne@acme.fr", phone_number: "+33100000000", note: "Rencontrée au salon", is_archived: false }] } },
      ...WRITES,
    ]);

    expect(await adapter.pushContact?.(JEANNE)).toEqual({ externalId: "501" });
    expect(withoutToken(calls)).toEqual([
      [`POST ${API}/companies/search`, { filters: { name: "ACME HOLDING" } }],
      [`POST ${API}/contacts/search`, { filters: { email: "jeanne@acme.fr" } }],
      [`PUT ${API}/contacts/501`, { civility: "mrs", first_name: "Jeanne", last_name: "Dupont-Martin", email: "jeanne@acme.fr", phone_number: "+33612345678", note: "Rencontrée au salon", position: "Présidente" }],
      [`POST ${API}/companies/301/contacts/501`],
      [`POST ${API}/comments`, NOTE],
    ]);
  });

  it("completes a company with what it lacks, without renaming it", async () => {
    const { adapter, calls } = client("sellsy", FIELDS, [
      TOKEN_ROUTE,
      { match: `POST ${API}/companies/search`, json: { data: [{ id: 301, name: "Acme", email: "contact@acme.fr", website: null, legal_france: { siret: null, siren: null, vat: "FR00900000001" } }] } },
      { match: `POST ${API}/contacts/search`, json: { data: [{ id: 501, first_name: "Jeanne", last_name: "Dupont-Martin", email: "jeanne@acme.fr", phone_number: "+33612345678", position: "Présidente" }] } },
      ...WRITES,
    ]);

    await adapter.pushContact?.(JEANNE);

    expect(withoutToken(calls)[1]).toEqual([`PUT ${API}/companies/301`, { name: "Acme", email: "contact@acme.fr", website: "https://www.acme.fr/contact", legal_france: { vat: "FR00900000001", siren: "900000001" } }]);
    expect(withoutToken(calls).some(([request]) => request === `PUT ${API}/contacts/501`)).toBe(false);
  });

  it("doesn't take a namesake with another SIREN for the company", async () => {
    const { adapter, calls } = client("sellsy", FIELDS, [
      TOKEN_ROUTE,
      { match: `POST ${API}/companies/search`, json: { data: [{ id: 300, name: "ACME HOLDING", legal_france: { siren: "111111111" } }] } },
      { match: `POST ${API}/contacts/search`, json: { data: [] } },
      ...WRITES,
    ]);

    await adapter.pushContact?.(JEANNE);

    expect(withoutToken(calls)[1][0]).toBe(`POST ${API}/companies`);
  });

  it("finds a contact without an address by last name within the company, and tells first names apart", async () => {
    const { adapter, calls } = client("sellsy", FIELDS, [
      TOKEN_ROUTE,
      { match: `POST ${API}/companies/search`, json: { data: [{ id: 301, website: "https://acme.fr", legal_france: { siren: "900000001" } }] } },
      {
        match: `POST ${API}/contacts/search`,
        json: {
          data: [
            { id: 500, first_name: "Paul", last_name: "Dupont-Martin" },
            { id: 501, first_name: "jeanne", last_name: "Dupont-Martin" },
          ],
        },
      },
      ...WRITES,
    ]);

    expect(await adapter.pushContact?.(WITHOUT_EMAIL)).toEqual({ externalId: "501" });
    expect(withoutToken(calls)[1]).toEqual([`POST ${API}/contacts/search`, { filters: { last_name: "Dupont-Martin", companies: [301] } }]);
  });
});

describe("Axonaut", () => {
  const API = "https://axonaut.com/api/v2";
  const FIELDS = { apiKey: "axonaut-secret" };
  const EVENT = { company_id: 301, employee_email: "jeanne@acme.fr", date: "2026-11-04T09:00:00.000Z", title: "Coldlyne", content: JEANNE.note, nature: 6, is_done: "true" };
  const WRITES: FakeRoute[] = [
    { match: `POST ${API}/companies`, json: { id: 301 } },
    { match: `POST ${API}/employees`, json: { id: 501 } },
    { match: `PATCH ${API}/employees`, json: { id: 501 } },
    { match: `POST ${API}/events`, json: { id: 901 } },
  ];

  it("names the connection after the account, with the key in its header", async () => {
    const { adapter, calls } = client("axonaut", FIELDS, [{ match: `GET ${API}/me`, json: { fullname: "Marie Durand", user_api_key: "axonaut-secret", account: [{ company_name: "Northwind" }] } }]);

    expect(await adapter.check()).toEqual({ ok: true, detail: "compte « Northwind »", label: "Northwind" });
    expect(calls[0].headers.get("userapikey")).toBe("axonaut-secret");
  });

  it("says when the key is refused", async () => {
    const { adapter } = client("axonaut", FIELDS, [{ match: `GET ${API}/me`, status: 401, json: { error: "Invalid API key" } }]);

    expect(await adapter.check()).toEqual({ ok: false, detail: "Axonaut a refusé les identifiants : Invalid API key" });
  });

  it("creates a new prospect and employee, keeping the SIREN and site in the comments, and adds a note event", async () => {
    const { adapter, calls } = client("axonaut", FIELDS, [
      { match: `GET ${API}/companies`, json: [] },
      { match: `GET ${API}/employees`, json: [] },
      ...WRITES,
    ]);

    expect(await adapter.pushContact?.(JEANNE)).toEqual({ externalId: "501" });
    expect(sent(calls)).toEqual([
      [`GET ${API}/companies?siret=900000001`],
      [`GET ${API}/companies?search=ACME%20HOLDING`],
      [`POST ${API}/companies`, { name: "ACME HOLDING", is_prospect: "true", comments: "SIREN 900000001\nhttps://www.acme.fr/contact" }],
      [`GET ${API}/employees?email=jeanne%40acme.fr`],
      [`POST ${API}/employees`, { company_id: 301, firstname: "Jeanne", lastname: "Dupont-Martin", email: "jeanne@acme.fr", phone_number: "+33612345678" }],
      [`POST ${API}/events`, EVENT],
    ]);
  });

  it("updates an employee already there, and finds their company by the SIREN its SIRET starts with", async () => {
    const { adapter, calls } = client("axonaut", FIELDS, [
      { match: `GET ${API}/companies?siret=`, json: [{ id: 301, name: "Acme", siret: "90000000100011" }] },
      { match: `GET ${API}/employees`, json: [{ id: 500, email: "autre.jeanne@acme.fr" }, { id: 501, email: "Jeanne@acme.fr" }] },
      ...WRITES,
    ]);

    expect(await adapter.pushContact?.(JEANNE)).toEqual({ externalId: "501" });
    expect(sent(calls)).toEqual([
      [`GET ${API}/companies?siret=900000001`],
      [`GET ${API}/employees?email=jeanne%40acme.fr`],
      [`PATCH ${API}/employees/501`, { firstname: "Jeanne", lastname: "Dupont-Martin", email: "jeanne@acme.fr", phone_number: "+33612345678" }],
      [`POST ${API}/events`, EVENT],
    ]);
  });

  it("finds a company by its exact name, not one that merely contains it or has another SIREN", async () => {
    const { adapter, calls } = client("axonaut", FIELDS, [
      { match: `GET ${API}/companies?siret=`, json: [] },
      {
        match: `GET ${API}/companies?search=`,
        json: [
          { id: 299, name: "ACME HOLDING GROUPE" },
          { id: 300, name: "ACME HOLDING", siret: "11111111100011" },
          { id: 301, name: "Acme Holding", siret: null },
        ],
      },
      { match: `GET ${API}/employees`, json: [] },
      ...WRITES,
    ]);

    await adapter.pushContact?.(JEANNE);

    expect(sent(calls)[2]).toEqual([`GET ${API}/employees?email=jeanne%40acme.fr`]);
    expect(JSON.parse(calls[3].body)).toMatchObject({ company_id: 301 });
  });

  it("finds a person without an address among the company's employees, and puts the event on the company alone", async () => {
    const { adapter, calls } = client("axonaut", FIELDS, [
      { match: `GET ${API}/companies?siret=`, json: [{ id: 301, siret: "90000000100011" }] },
      { match: `GET ${API}/companies/301/employees`, json: [{ id: 500, firstname: "Paul", lastname: "Dupont-Martin" }, { id: 501, firstname: "Jeanne", lastname: "Dupont-Martin" }] },
      ...WRITES,
    ]);

    expect(await adapter.pushContact?.(WITHOUT_EMAIL)).toEqual({ externalId: "501" });
    expect(sent(calls).at(-1)).toEqual([`POST ${API}/events`, { ...EVENT, employee_email: undefined }]);
  });
});

describe("noCRM.io", () => {
  const API = "https://northwind.nocrm.io/api/v2";
  const FIELDS = { subdomain: "northwind", apiKey: "nocrm-secret" };
  const DESCRIPTION = "Firstname: Jeanne\nLastname: Dupont-Martin\nEmail: jeanne@acme.fr\nPhone: +33612345678\nJob title: Présidente\nWebsite: https://www.acme.fr/contact\nSIREN: 900000001";
  const COMMENT: FakeRoute = { match: `POST ${API}/leads/701/comments`, json: { id: 901 } };
  const FIND = `${API}/leads?email=jeanne%40acme.fr&include_unassigned=true`;

  it("checks the key and names the connection after its subdomain, the only name noCRM gives", async () => {
    const { adapter, calls } = client("nocrm", FIELDS, [{ match: `GET ${API}/ping`, json: { status: 200, message: "Your API key is correct." } }]);

    expect(await adapter.check()).toEqual({ ok: true, detail: "compte « northwind »", label: "northwind" });
    expect(calls[0].headers.get("x-api-key")).toBe("nocrm-secret");
  });

  it("says when the key is refused, and refuses a subdomain that would send it elsewhere", async () => {
    const refused = client("nocrm", FIELDS, [{ match: `GET ${API}/ping`, status: 401, json: { error: "unauthorized_invalid_token", message: "Invalid API key" } }]);
    expect(await refused.adapter.check()).toEqual({ ok: false, detail: "noCRM.io a refusé les identifiants : Invalid API key" });

    const elsewhere = client("nocrm", { ...FIELDS, subdomain: "evil.example/x#" }, []);
    expect(await elsewhere.adapter.check()).toMatchObject({ ok: false, detail: expect.stringContaining("Le sous-domaine noCRM.io") });
    expect(elsewhere.calls).toEqual([]);
  });

  it("creates a lead holding the person and the company, and adds the comment", async () => {
    const { adapter, calls } = client("nocrm", FIELDS, [{ match: `GET ${API}/leads`, json: [] }, { match: `POST ${API}/leads/701`, json: { id: 901 } }, { match: `POST ${API}/leads`, json: { id: 701 } }]);

    expect(await adapter.pushContact?.(JEANNE)).toEqual({ externalId: "701" });
    expect(sent(calls)).toEqual([[`GET ${FIND}`], [`POST ${API}/leads`, { title: "ACME HOLDING", description: DESCRIPTION }], [`POST ${API}/leads/701/comments`, { content: JEANNE.note }]]);
  });

  it("adds what a lead already there lacks, keeping what a member wrote in it", async () => {
    const { adapter, calls } = client("nocrm", FIELDS, [{ match: `GET ${API}/leads`, json: [{ id: 701, title: "Acme", description: "Email: jeanne@acme.fr\nA rappeler en janvier" }] }, { match: `PUT ${API}/leads/701`, json: {} }, COMMENT]);

    expect(await adapter.pushContact?.({ ...JEANNE, firstName: null, role: null, company: { ...JEANNE.company, website: null, siren: null } })).toEqual({ externalId: "701" });
    expect(sent(calls)).toEqual([
      [`GET ${FIND}`],
      [`PUT ${API}/leads/701`, { description: "Email: jeanne@acme.fr\nA rappeler en janvier\nLastname: Dupont-Martin\nPhone: +33612345678" }],
      [`POST ${API}/leads/701/comments`, { content: JEANNE.note }],
    ]);
  });

  it("writes nothing to a lead that already says it all, reads its text under either name, and prefers the lead that names the address", async () => {
    const { adapter, calls } = client("nocrm", FIELDS, [{ match: `GET ${API}/leads`, json: [{ id: 700, title: "Autre", description: "Sans rapport" }, { id: 701, title: "ACME HOLDING", text_description: DESCRIPTION }] }, COMMENT]);

    expect(await adapter.pushContact?.(JEANNE)).toEqual({ externalId: "701" });
    expect(sent(calls)).toEqual([[`GET ${FIND}`], [`POST ${API}/leads/701/comments`, { content: JEANNE.note }]]);
  });

  it("compares the latest leads when there's no address to search by", async () => {
    const { adapter, calls } = client("nocrm", FIELDS, [
      {
        match: `GET ${API}/leads`,
        json: [
          { id: 700, title: "ACME HOLDING", description: "Firstname: Paul\nLastname: Dupont-Martin" },
          { id: 701, title: "acme holding", description: "Firstname: Jeanne\nLastname: Dupont-Martin\nPhone: +33612345678\nJob title: Présidente\nWebsite: https://www.acme.fr/contact\nSIREN: 900000001" },
        ],
      },
      COMMENT,
    ]);

    expect(await adapter.pushContact?.(WITHOUT_EMAIL)).toEqual({ externalId: "701" });
    expect(sent(calls)[0]).toEqual([`GET ${API}/leads?include_unassigned=true&limit=100`]);
    expect(calls).toHaveLength(2);
  });
});

describe("folk", () => {
  const API = "https://api.folk.app/v1";
  const FIELDS = { apiKey: "folk-secret" };
  const BY_DOMAIN = `${API}/companies?filter[urls][like]=acme.fr&limit=100`;
  const BY_NAME = `${API}/companies?filter[name][eq]=ACME%20HOLDING&limit=100`;
  const BY_EMAIL = `${API}/people?filter[emails][like]=jeanne%40acme.fr&limit=100`;
  const NOTE = { entity: { id: "per_1" }, visibility: "public", content: JEANNE.note };
  const WRITES: FakeRoute[] = [
    { match: `POST ${API}/companies`, json: { data: { id: "com_1" } } },
    { match: `POST ${API}/people`, json: { data: { id: "per_1" } } },
    { match: `PATCH ${API}/`, json: { data: {} } },
    { match: `POST ${API}/notes`, json: { data: { id: "nte_1" } } },
  ];
  const items = (list: unknown[]) => ({ data: { items: list, pagination: {} } });

  it("names the connection after the key's owner, folk having no workspace name to give, and sends its version", async () => {
    const { adapter, calls } = client("folk", FIELDS, [{ match: `GET ${API}/users/me`, json: { data: { id: "usr_1", fullName: "Marie Durand", email: "marie@northwind.fr" } } }]);

    expect(await adapter.check()).toEqual({ ok: true, detail: "compte « Marie Durand »", label: "Marie Durand" });
    expect(calls[0].headers.get("authorization")).toBe("Bearer folk-secret");
    expect(calls[0].headers.get("x-api-version")).toBe("2025-06-09");
  });

  it("says when the key is refused", async () => {
    const { adapter } = client("folk", FIELDS, [{ match: `GET ${API}/users/me`, status: 401, json: { error: { code: "UNAUTHORIZED", message: "Invalid API key" } } }]);

    expect(await adapter.check()).toEqual({ ok: false, detail: "folk a refusé les identifiants : Invalid API key" });
  });

  it("creates a new person and company, and adds the note", async () => {
    const { adapter, calls } = client("folk", FIELDS, [{ match: `GET ${API}/companies`, json: items([]) }, { match: `GET ${API}/people`, json: items([]) }, ...WRITES]);

    expect(await adapter.pushContact?.(JEANNE)).toEqual({ externalId: "per_1" });
    expect(sent(calls)).toEqual([
      [`GET ${BY_DOMAIN}`],
      [`GET ${BY_NAME}`],
      [`POST ${API}/companies`, { name: "ACME HOLDING", urls: ["https://www.acme.fr/contact"] }],
      [`GET ${BY_EMAIL}`],
      [`POST ${API}/people`, { firstName: "Jeanne", lastName: "Dupont-Martin", jobTitle: "Présidente", emails: ["jeanne@acme.fr"], phones: ["+33612345678"], companies: [{ id: "com_1" }] }],
      [`POST ${API}/notes`, NOTE],
    ]);
  });

  it("updates a person already there, merging into the lists an update would replace", async () => {
    const { adapter, calls } = client("folk", FIELDS, [
      { match: `GET ${BY_DOMAIN}`, json: items([{ id: "com_0", urls: ["https://acme.fr.example.com"] }, { id: "com_1", urls: ["https://acme.fr"] }]) },
      { match: `GET ${API}/people`, json: items([{ id: "per_0", emails: ["ajeanne@acme.fr"] }, { id: "per_1", emails: ["autre@acme.fr", "Jeanne@acme.fr"], phones: ["+33 1 23 45 67 89"], companies: [{ id: "com_9", name: "Autre" }] }]) },
      ...WRITES,
    ]);

    expect(await adapter.pushContact?.(JEANNE)).toEqual({ externalId: "per_1" });
    expect(sent(calls)).toEqual([
      [`GET ${BY_DOMAIN}`],
      [`GET ${BY_EMAIL}`],
      [
        `PATCH ${API}/people/per_1`,
        { firstName: "Jeanne", lastName: "Dupont-Martin", jobTitle: "Présidente", emails: ["autre@acme.fr", "Jeanne@acme.fr"], phones: ["+33 1 23 45 67 89", "+33612345678"], companies: [{ id: "com_9" }, { id: "com_1" }] },
      ],
      [`POST ${API}/notes`, NOTE],
    ]);
  });

  it("adds a site to a company found by name, without renaming it", async () => {
    const { adapter, calls } = client("folk", FIELDS, [
      { match: `GET ${BY_DOMAIN}`, json: items([]) },
      { match: `GET ${BY_NAME}`, json: items([{ id: "com_1", name: "ACME HOLDING", urls: ["https://autre.fr"] }]) },
      { match: `GET ${API}/people`, json: items([]) },
      ...WRITES,
    ]);

    await adapter.pushContact?.(JEANNE);

    expect(sent(calls)[2]).toEqual([`PATCH ${API}/companies/com_1`, { urls: ["https://autre.fr", "https://www.acme.fr/contact"] }]);
  });

  it("finds a person without an address by name within the company", async () => {
    const { adapter, calls } = client("folk", FIELDS, [{ match: `GET ${BY_DOMAIN}`, json: items([{ id: "com_1", urls: ["https://www.acme.fr"] }]) }, { match: `GET ${API}/people`, json: items([{ id: "per_1", companies: [{ id: "com_1" }] }]) }, ...WRITES]);

    expect(await adapter.pushContact?.(WITHOUT_EMAIL)).toEqual({ externalId: "per_1" });
    expect(calls[1].url).toBe(`${API}/people?filter[fullName][eq]=Jeanne%20Dupont-Martin&filter[companies][in][id]=com_1&limit=100`);
  });
});
