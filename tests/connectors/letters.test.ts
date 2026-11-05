import { describe, expect, it } from "vitest";
import type { PostalAddress } from "@/application/ports";
import { adapterOf } from "@/infrastructure/connectors";
import { maileva } from "@/infrastructure/connectors/letters/maileva";
import { merciFacteur, merciFacteurSignature } from "@/infrastructure/connectors/letters/merci-facteur";
import { adapterContext, fakeFetch, type FakeRoute } from "../support/fetch";

const TO: PostalAddress = { name: "Jeanne Dupont-Martin", company: "ACME HOLDING", lines: ["12 RUE DE LA REPUBLIQUE"], postcode: "69002", city: "Lyon", country: "FR" };
const FROM: PostalAddress = { name: "Marie Durand", company: "Northwind", lines: ["Bâtiment B", "10 avenue de Paris", "BP 105"], postcode: "75002", city: "Paris", country: "FR" };
const PDF = new Uint8Array([37, 80, 68, 70]); // %PDF
const LETTER = { to: TO, from: FROM, pdf: PDF, reference: "northwind/campagne-1:étape-2" };
/** The test clock, in Unix seconds. */
const NOW = 1793782800;

describe("the letter connectors", () => {
  it("are found by their kind", () => {
    expect(adapterOf("merci_facteur")).toBe(merciFacteur);
    expect(adapterOf("maileva")).toBe(maileva);
  });
});

describe("Merci Facteur", () => {
  const FIELDS = { serviceId: "service-1", secretKey: "mf-secret", userId: "4417" };
  const API = "https://www.merci-facteur.com/api/1.2/prod/service";
  const TOKEN: FakeRoute = { match: `GET ${API}/getToken`, json: { success: true, error: "", token: "mf-token", expire: NOW + 86400 } };
  const QUOTA: FakeRoute = { match: `GET ${API}/getQuotaCompte`, json: { success: true, error: "", quotas: { plan: { name: "Pro", expire: "2027-01-01 00:00:00" }, credit: { amount: "12.50", devise: "EUR" }, pages: { thisMounth: 3, maxMounth: 100, total: 30 } } } };

  it("signs with HMAC-SHA256 of the service id and the time, in hex", () => {
    // Known answer, worked out apart from this code: printf '%s' 'service-11793782800' | openssl dgst -sha256 -hmac 'mf-secret'
    expect(merciFacteurSignature("service-1", "mf-secret", NOW)).toBe("cc735f4eebf23f790c2218898e88d92c620958c70f4eec240f3c4a214b804b3f");
  });

  it("asks for a token with its signature, then checks the account's plan and credit", async () => {
    const { fetch, calls } = fakeFetch([TOKEN, QUOTA]);

    expect(await merciFacteur(adapterContext(FIELDS, fetch)).check()).toEqual({ ok: true, label: "Pro", detail: "Solde : 12,50 €" });

    expect(calls[0].url).toBe(`${API}/getToken`);
    expect(calls[0].headers.get("ww-service-signature")).toBe("cc735f4eebf23f790c2218898e88d92c620958c70f4eec240f3c4a214b804b3f");
    expect(calls[0].headers.get("ww-timestamp")).toBe(String(NOW));
    expect(calls[0].headers.get("ww-service-id")).toBe("service-1");
    expect(calls[0].headers.get("ww-authorized-ip")).toBe("111.111.111");
    expect(calls[1].headers.get("ww-service-id")).toBe("service-1");
    expect(calls[1].headers.get("ww-access-token")).toBe("mf-token");
  });

  it("doesn't invent a balance from an amount it can't read", async () => {
    const { fetch } = fakeFetch([TOKEN, { match: `GET ${API}/getQuotaCompte`, json: { success: true, quotas: { credit: { amount: "n/a" } } } }]);

    expect(await merciFacteur(adapterContext(FIELDS, fetch)).check()).toEqual({ ok: true, detail: "Compte actif" });
  });

  it("says when the keys are refused, in Merci Facteur's words", async () => {
    const { fetch } = fakeFetch([{ match: `GET ${API}/getToken`, status: 401, json: { success: false, error: { code: "AUTH_ERROR", text: "Signature invalide" } } }]);
    const check = await merciFacteur(adapterContext(FIELDS, fetch)).check();

    expect(check.ok).toBe(false);
    expect(check.detail).toContain("Merci Facteur a refusé les identifiants");
    expect(check.detail).toContain("Signature invalide");
  });

  it("says when the answer is a refusal despite its status", async () => {
    const { fetch } = fakeFetch([{ match: `GET ${API}/getToken`, json: { success: false, error: { code: "AUTH_ERROR" } } }]);

    expect(await merciFacteur(adapterContext(FIELDS, fetch)).check()).toEqual({ ok: false, detail: "Merci Facteur a refusé la demande : AUTH_ERROR" });
  });

  it("says in the check that a letter needs the user it is sent as", async () => {
    const { fetch } = fakeFetch([TOKEN, QUOTA]);

    expect(await merciFacteur(adapterContext({ serviceId: "service-1", secretKey: "mf-secret" }, fetch)).check()).toEqual({ ok: false, label: "Pro", detail: "Indiquez l’identifiant de l’utilisateur Merci Facteur au nom duquel partent les courriers (menu Utilisateurs)." });
  });

  it("posts a simple letter as a form, its address and content as JSON strings, the PDF in base64, once per reference", async () => {
    const { fetch, calls } = fakeFetch([TOKEN, { match: `POST ${API}/sendCourrier`, json: { success: true, error: "", envoi_id: [123], price: { total: { ht: "1.20", ttc: "1.44" } }, resume: { nb_dest: 1, nb_page: 1 } } }]);

    const sent = await merciFacteur(adapterContext(FIELDS, fetch)).postLetter!(LETTER);

    expect(sent).toEqual({ externalId: "123", cost: 1.44 });
    const call = calls[1];
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${API}/sendCourrier`);
    expect(call.headers.get("ww-service-id")).toBe("service-1");
    expect(call.headers.get("ww-access-token")).toBe("mf-token");
    expect(call.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    const form = Object.fromEntries(new URLSearchParams(call.body));
    expect(form).toMatchObject({ idUser: "4417", modeEnvoi: "normal", designation: "northwind/campagne-1:étape-2", antidoublon: "northwind/campagne-1:étape-2" });
    expect(JSON.parse(form.content)).toEqual({ letter: { files: "", base64files: ["JVBERg=="], print_sides: "recto" }, photo: "", card: "" });
    expect(JSON.parse(form.adress)).toEqual({
      exp: { civilite: "", nom: "Marie Durand", prenom: "", societe: "Northwind", adresse1: "Bâtiment B", adresse2: "10 avenue de Paris", adresse3: "BP 105", cp: "75002", ville: "Paris", pays: "FRANCE" },
      dest: [{ civilite: "", nom: "Jeanne Dupont-Martin", prenom: "", societe: "ACME HOLDING", adresse1: "12 RUE DE LA REPUBLIQUE", adresse2: "", adresse3: "", cp: "69002", ville: "Lyon", pays: "FRANCE", reference: "northwind-campagne-1--tape-2" }],
    });
  });

  it("reads a price with a French decimal comma, and drops one it can't read", async () => {
    const routes = (ttc: unknown): FakeRoute[] => [TOKEN, { match: `POST ${API}/sendCourrier`, json: { success: true, envoi_id: [1], price: { total: { ttc } } } }];

    expect(await merciFacteur(adapterContext(FIELDS, fakeFetch(routes("1,44")).fetch)).postLetter!(LETTER)).toEqual({ externalId: "1", cost: 1.44 });
    expect(await merciFacteur(adapterContext(FIELDS, fakeFetch(routes("gratuit")).fetch)).postLetter!(LETTER)).toEqual({ externalId: "1" });
  });

  it("reads the id and the price as either of the shapes its docs show, and asks for one token", async () => {
    const routes = (json: unknown): FakeRoute[] => [TOKEN, { match: `POST ${API}/sendCourrier`, json }];
    const scalar = fakeFetch(routes({ success: true, envoi_id: 123, price: { total: { ht: 0, ttc: 0 } } }));
    const unpriced = fakeFetch(routes({ success: true, envoi_id: [124] }));
    const adapter = merciFacteur(adapterContext(FIELDS, scalar.fetch));

    expect(await adapter.postLetter!(LETTER)).toEqual({ externalId: "123", cost: 0 });
    await adapter.postLetter!(LETTER);
    expect(scalar.calls.filter((call) => call.url.endsWith("/getToken"))).toHaveLength(1);
    expect(await merciFacteur(adapterContext(FIELDS, unpriced.fetch)).postLetter!(LETTER)).toEqual({ externalId: "124" });
  });

  it("asks for a new token once the last one is about to expire", async () => {
    let now = new Date(NOW * 1000);
    const { fetch, calls } = fakeFetch([TOKEN, QUOTA]);
    const adapter = merciFacteur(adapterContext(FIELDS, fetch, { now: () => now }));

    await adapter.check();
    now = new Date((NOW + 86400 - 10) * 1000);
    await adapter.check();

    expect(calls.filter((call) => call.url.endsWith("/getToken"))).toHaveLength(2);
  });

  it("says what is refused", async () => {
    const { fetch } = fakeFetch([TOKEN, { match: `POST ${API}/sendCourrier`, status: 400, json: { success: false, error: { code: "INFO_ADDRESS_MISSING", text: "Adresse incomplète" } } }]);

    await expect(merciFacteur(adapterContext(FIELDS, fetch)).postLetter!(LETTER)).rejects.toThrow("Adresse incomplète");
  });

  it("doesn't post a letter without the user it is sent as", async () => {
    const { fetch, calls } = fakeFetch([TOKEN]);

    await expect(merciFacteur(adapterContext({ serviceId: "service-1", secretKey: "mf-secret" }, fetch)).postLetter!(LETTER)).rejects.toThrow("Indiquez l’identifiant de l’utilisateur Merci Facteur");
    expect(calls).toHaveLength(0);
  });
});

describe("Maileva", () => {
  const FIELDS = { clientId: "client-1", clientSecret: "client-secret", username: "marie@northwind.fr", password: "mv-password" };
  const TOKEN_URL = "https://connexion.maileva.com/auth/realms/services/protocol/openid-connect/token";
  const API = "https://api.maileva.com/mail/v3";
  const TOKEN: FakeRoute = { match: `POST ${TOKEN_URL}`, json: { access_token: "mv-token", expires_in: 900, token_type: "bearer" } };
  const FLOW: FakeRoute[] = [
    TOKEN,
    { match: `POST ${API}/sendings/s-1/documents`, status: 201, json: { id: "d-1" } },
    { match: `POST ${API}/sendings/s-1/recipients`, status: 201, json: { id: "r-1" } },
    { match: `POST ${API}/sendings/s-1/submit`, status: 200 },
    { match: `POST ${API}/sendings`, status: 201, json: { id: "s-1", status: "DRAFT" } },
  ];

  it("asks for a token with the password grant, then checks the sendings it can read", async () => {
    const { fetch, calls } = fakeFetch([TOKEN, { match: `GET ${API}/sendings?count=1`, json: { sendings: [], paging: { total_results: 3 } } }]);

    expect(await maileva(adapterContext(FIELDS, fetch)).check()).toEqual({ ok: true, label: "marie@northwind.fr", detail: "3 envois sur ce compte" });

    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(TOKEN_URL);
    expect(calls[0].headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(calls[0].body))).toEqual({ grant_type: "password", username: "marie@northwind.fr", password: "mv-password", client_id: "client-1", client_secret: "client-secret" });
    expect(calls[1].url).toBe(`${API}/sendings?count=1`);
    expect(calls[1].headers.get("authorization")).toBe("Bearer mv-token");
  });

  it("says when an account has sent nothing yet, or one thing", async () => {
    const route = (total: number): FakeRoute[] => [TOKEN, { match: `GET ${API}/sendings?count=1`, json: { sendings: [], paging: { total_results: total } } }];

    expect((await maileva(adapterContext(FIELDS, fakeFetch(route(0)).fetch)).check()).detail).toBe("Aucun envoi pour le moment");
    expect((await maileva(adapterContext(FIELDS, fakeFetch(route(1)).fetch)).check()).detail).toBe("1 envoi sur ce compte");
  });

  it("says when the identifiers are refused", async () => {
    const { fetch } = fakeFetch([{ match: `POST ${TOKEN_URL}`, status: 401, json: { error: "invalid_grant", error_description: "Invalid user credentials" } }]);
    const check = await maileva(adapterContext(FIELDS, fetch)).check();

    expect(check.ok).toBe(false);
    expect(check.detail).toContain("Maileva a refusé les identifiants");
    expect(check.detail).toContain("Invalid user credentials");
  });

  it("creates the sending in black and white on one side, adds the document and the recipient, then submits", async () => {
    const { fetch, calls } = fakeFetch(FLOW);

    const sent = await maileva(adapterContext(FIELDS, fetch)).postLetter!(LETTER);

    expect(sent).toEqual({ externalId: "s-1" });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([`POST ${TOKEN_URL}`, `POST ${API}/sendings`, `POST ${API}/sendings/s-1/documents`, `POST ${API}/sendings/s-1/recipients`, `POST ${API}/sendings/s-1/submit`]);
    expect(calls.slice(1).map((call) => call.headers.get("authorization"))).toEqual(["Bearer mv-token", "Bearer mv-token", "Bearer mv-token", "Bearer mv-token"]);
    expect(JSON.parse(calls[1].body)).toEqual({
      name: "northwind/campagne-1:étape-2",
      custom_id: "northwind/campagne-1:étape-2",
      color_printing: false,
      duplex_printing: false,
      optional_address_sheet: true,
      envelope_windows_type: "SIMPLE",
      postage_type: "FAST",
      sender_address_line_1: "Northwind",
      sender_address_line_2: "Marie Durand",
      sender_address_line_3: "Bâtiment B",
      sender_address_line_4: "10 avenue de Paris",
      sender_address_line_5: "BP 105",
      sender_address_line_6: "75002 PARIS",
      sender_country_code: "FR",
    });
    expect(JSON.parse(calls[3].body)).toEqual({ custom_id: "northwind/campagne-1:étape-2", address_line_1: "ACME HOLDING", address_line_2: "Jeanne Dupont-Martin", address_line_4: "12 RUE DE LA REPUBLIQUE", address_line_6: "69002 LYON", country_code: "FR" });
    expect(calls[4].body).toBe("");
  });

  it("sends the document as multipart, each part with its type and no content type of its own", async () => {
    const { fetch, calls } = fakeFetch(FLOW);
    const bodies: unknown[] = [];
    const recording = ((input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(init?.body);
      return fetch(input, init);
    }) as typeof fetch;

    await maileva(adapterContext(FIELDS, recording)).postLetter!(LETTER);

    const form = bodies[2] as FormData;
    const document = form.get("document") as File;
    const metadata = form.get("metadata") as File;
    expect(calls[2].headers.get("content-type")).toBeNull();
    expect(document.type).toBe("application/octet-stream");
    expect(document.name).toBe("northwind/campagne-1:étape-2.pdf");
    expect(new Uint8Array(await document.arrayBuffer())).toEqual(PDF);
    expect(metadata.type).toBe("application/json");
    expect(JSON.parse(await metadata.text())).toEqual({ priority: 1, name: "northwind/campagne-1:étape-2.pdf" });
  });

  it("cuts a line to the 38 characters allowed, and a reference to the 36 of its id", async () => {
    const { fetch, calls } = fakeFetch(FLOW);
    const long = "SOCIETE CIVILE IMMOBILIERE DES GRANDS BOULEVARDS";

    await maileva(adapterContext(FIELDS, fetch)).postLetter!({ ...LETTER, to: { ...TO, company: long }, reference: "r".repeat(50) });

    expect(JSON.parse(calls[3].body)).toMatchObject({ address_line_1: long.slice(0, 38), custom_id: "r".repeat(36) });
    expect(JSON.parse(calls[1].body)).toMatchObject({ name: "r".repeat(50), custom_id: "r".repeat(36) });
  });

  it("keeps a person with no company, and two address lines, in their places", async () => {
    const { fetch, calls } = fakeFetch(FLOW);

    await maileva(adapterContext(FIELDS, fetch)).postLetter!({ ...LETTER, to: { name: "Jeanne Martin", lines: ["Résidence des Pins", "3 rue Haute"], postcode: "69002", city: "LYON", country: "FR" } });

    expect(JSON.parse(calls[3].body)).toEqual({ custom_id: LETTER.reference, address_line_2: "Jeanne Martin", address_line_3: "Résidence des Pins", address_line_4: "3 rue Haute", address_line_6: "69002 LYON", country_code: "FR" });
  });

  it("doesn't count a letter as failed when the submit's answer is unreadable: it has left", async () => {
    const { fetch } = fakeFetch([TOKEN, FLOW[1], FLOW[2], { match: `POST ${API}/sendings/s-1/submit`, status: 200, text: "OK" }, FLOW[4]]);

    await expect(maileva(adapterContext(FIELDS, fetch)).postLetter!(LETTER)).resolves.toEqual({ externalId: "s-1" });
  });

  it("stops at the step refused, in Maileva's words, and never submits", async () => {
    const { fetch, calls } = fakeFetch([TOKEN, FLOW[1], { match: `POST ${API}/sendings/s-1/recipients`, status: 400, json: { errors: [{ code: "invalid", message: "La ligne 6 est invalide", target: "address_line_6" }] } }, FLOW[3], FLOW[4]]);

    await expect(maileva(adapterContext(FIELDS, fetch)).postLetter!(LETTER)).rejects.toThrow("La ligne 6 est invalide");
    expect(calls.some((call) => call.url.endsWith("/submit"))).toBe(false);
  });

  it("says when the submit itself is refused", async () => {
    const { fetch } = fakeFetch([TOKEN, FLOW[1], FLOW[2], { match: `POST ${API}/sendings/s-1/submit`, status: 403, json: { message: "Solde insuffisant" } }, FLOW[4]]);

    await expect(maileva(adapterContext(FIELDS, fetch)).postLetter!(LETTER)).rejects.toThrow("Solde insuffisant");
  });
});
