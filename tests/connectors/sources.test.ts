import { describe, expect, it } from "vitest";
import { adapterOf } from "@/infrastructure/connectors";
import { googleSheets } from "@/infrastructure/connectors/sources/google-sheets";
import { inpi } from "@/infrastructure/connectors/sources/inpi";
import { sirene } from "@/infrastructure/connectors/sources/sirene";
import { adapterContext, fakeFetch } from "../support/fetch";

const SIRENE = "https://api.insee.fr/api-sirene/3.11";
const INPI = "https://registre-national-entreprises.inpi.fr/api";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";

// Shapes trimmed from INSEE's documented answers, with a made-up company.
const legalUnit = (overrides: Record<string, unknown> = {}, period: Record<string, unknown> = {}) => ({
  header: { statut: 200, message: "OK" },
  uniteLegale: {
    siren: "732829320",
    statutDiffusionUniteLegale: "O",
    dateCreationUniteLegale: "2019-03-01",
    sigleUniteLegale: null,
    prenomUsuelUniteLegale: null,
    trancheEffectifsUniteLegale: "11",
    anneeEffectifsUniteLegale: "2024",
    categorieEntreprise: "PME",
    periodesUniteLegale: [
      { dateFin: null, dateDebut: "2024-01-01", etatAdministratifUniteLegale: "A", nomUniteLegale: null, denominationUniteLegale: "ACME HOLDING", categorieJuridiqueUniteLegale: "5710", activitePrincipaleUniteLegale: "64.20Z", nomenclatureActivitePrincipaleUniteLegale: "NAFRev2", ...period },
      { dateFin: "2023-12-31", dateDebut: "2019-03-01", etatAdministratifUniteLegale: "A", denominationUniteLegale: "ACME ANCIENNE", activitePrincipaleUniteLegale: "70.10Z" },
    ],
    ...overrides,
  },
});

const establishments = {
  header: { statut: 200, message: "OK", total: 2, debut: 0, nombre: 2 },
  etablissements: [
    {
      siret: "73282932000012",
      etablissementSiege: true,
      trancheEffectifsEtablissement: "11",
      anneeEffectifsEtablissement: "2024",
      adresseEtablissement: { complementAdresseEtablissement: "BATIMENT B", numeroVoieEtablissement: "25", indiceRepetitionEtablissement: "BIS", typeVoieEtablissement: "RUE", libelleVoieEtablissement: "DE LA REPUBLIQUE", codePostalEtablissement: "69002", libelleCommuneEtablissement: "LYON", distributionSpecialeEtablissement: "BP 12", codeCedexEtablissement: "69287", libelleCedexEtablissement: "LYON CEDEX 02" },
      periodesEtablissement: [{ dateFin: null, etatAdministratifEtablissement: "A", enseigne1Etablissement: "ACME", denominationUsuelleEtablissement: null, activitePrincipaleEtablissement: "64.20Z" }],
    },
    {
      siret: "73282932000020",
      etablissementSiege: false,
      trancheEffectifsEtablissement: "NN",
      anneeEffectifsEtablissement: null,
      adresseEtablissement: { numeroVoieEtablissement: "[ND]", typeVoieEtablissement: "[ND]", libelleVoieEtablissement: "[ND]", codePostalEtablissement: "[ND]", libelleCommuneEtablissement: "GRENOBLE" },
      periodesEtablissement: [
        { dateFin: null, etatAdministratifEtablissement: "F", denominationUsuelleEtablissement: "ACME ALPES", activitePrincipaleEtablissement: "64.20Z" },
        { dateFin: "2021-05-31", etatAdministratifEtablissement: "A" },
      ],
    },
  ],
};

describe("the INSEE Sirene connector", () => {
  it("is registered under its kind", () => {
    expect(adapterOf("sirene")).toBe(sirene);
    expect(adapterOf("inpi")).toBe(inpi);
    expect(adapterOf("google_sheets")).toBe(googleSheets);
  });

  it("accepts a key the informations service answers to, sending it in INSEE's header", async () => {
    const { fetch, calls } = fakeFetch([{ match: `GET ${SIRENE}/informations`, json: { header: { statut: 200, message: "OK" }, etatService: "UP", versionService: "3.11.3" } }]);

    expect(await sirene(adapterContext({ apiKey: "cle-insee" }, fetch)).check()).toEqual({ ok: true, detail: "API Sirene 3.11.3\u00A0: clé acceptée" });
    expect(calls[0].headers.get("X-INSEE-Api-Key-Integration")).toBe("cle-insee");
  });

  it("says when the key is refused, and when the service is down", async () => {
    const refused = fakeFetch([{ match: `GET ${SIRENE}/informations`, status: 401, json: { message: "Unauthorized", http_status_code: 401 } }]);
    const down = fakeFetch([{ match: `GET ${SIRENE}/informations`, json: { etatService: "DOWN" } }]);

    expect(await sirene(adapterContext({ apiKey: "non" }, refused.fetch)).check()).toMatchObject({ ok: false, detail: expect.stringContaining("L’INSEE a refusé les identifiants") });
    expect(await sirene(adapterContext({ apiKey: "oui" }, down.fetch)).check()).toEqual({ ok: false, detail: "L’API Sirene est indisponible pour le moment." });
  });

  it("says when INSEE can't be reached at all", async () => {
    const unreachable = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    expect(await sirene(adapterContext({ apiKey: "oui" }, unreachable)).check()).toEqual({ ok: false, detail: "L’INSEE ne répond pas correctement pour le moment." });
  });

  it("gives the legal unit as it stands today and all its establishments, open or closed", async () => {
    const { fetch, calls } = fakeFetch([
      { match: `GET ${SIRENE}/siren/732829320`, json: legalUnit() },
      { match: `GET ${SIRENE}/siret`, json: establishments },
    ]);

    const company = await sirene(adapterContext({ apiKey: "cle" }, fetch)).company!("732829320");

    expect(new URL(calls[1].url).searchParams.get("q")).toBe("siren:732829320");
    expect(new URL(calls[1].url).searchParams.get("nombre")).toBe("1000");
    expect(company).toMatchObject({
      siren: "732829320",
      name: "ACME HOLDING",
      facts: { active: true, registryOptOut: false, legalForm: "5710", activity: "64.20Z", activityNomenclature: "NAFRev2", createdOn: "2019-03-01", headcountBand: "11", headcountYear: "2024", category: "PME", establishmentsTotal: 2 },
    });
    expect(company?.facts.headOffice).toEqual({
      siret: "73282932000012",
      headOffice: true,
      open: true,
      name: "ACME",
      activity: "64.20Z",
      headcountBand: "11",
      headcountYear: "2024",
      address: { lines: ["BATIMENT B", "25 BIS RUE DE LA REPUBLIQUE", "BP 12"], postcode: "69002", city: "LYON", cedex: "69287 LYON CEDEX 02" },
    });
    expect((company?.facts.establishments as { siret: string; open: boolean }[]).map(({ siret, open }) => [siret, open])).toEqual([
      ["73282932000012", true],
      ["73282932000020", false],
    ]);
  });

  it("treats what INSEE withholds as unknown, and partial diffusion as a refusal to be prospected", async () => {
    const { fetch } = fakeFetch([
      { match: `GET ${SIRENE}/siren/`, json: legalUnit({ statutDiffusionUniteLegale: "P", sigleUniteLegale: "[ND]" }, { denominationUniteLegale: "[ND]", nomUniteLegale: "[ND]" }) },
      { match: `GET ${SIRENE}/siret`, json: establishments },
    ]);

    const company = await sirene(adapterContext({ apiKey: "cle" }, fetch)).company!("732829320");

    expect(company).toMatchObject({ name: "732829320", facts: { registryOptOut: true } });
    expect((company?.facts.establishments as { address: unknown }[])[1].address).toEqual({ lines: [], postcode: null, city: "GRENOBLE", cedex: null });
  });

  it("calls a sole trader by the name they go by", async () => {
    const { fetch } = fakeFetch([
      { match: `GET ${SIRENE}/siren/`, json: legalUnit({ prenomUsuelUniteLegale: "JEANNE" }, { denominationUniteLegale: null, nomUniteLegale: "MARTIN", nomUsageUniteLegale: "DUPONT" }) },
      { match: `GET ${SIRENE}/siret`, status: 404, json: { header: { statut: 404, message: "Aucun élément trouvé" } } },
    ]);

    expect(await sirene(adapterContext({ apiKey: "cle" }, fetch)).company!("732829320")).toMatchObject({ name: "JEANNE DUPONT", facts: { establishments: [], establishmentsTotal: 0, headOffice: null } });
  });

  it("knows nothing of a company INSEE doesn't, and lets other failures through", async () => {
    const unknown = fakeFetch([{ match: `GET ${SIRENE}/siren/`, status: 404, json: { header: { statut: 404, message: "Aucun élément trouvé" } } }]);
    const quota = fakeFetch([{ match: `GET ${SIRENE}/siren/`, status: 429, json: {} }]);

    expect(await sirene(adapterContext({ apiKey: "cle" }, unknown.fetch)).company!("732829320")).toBeNull();
    await expect(sirene(adapterContext({ apiKey: "cle" }, quota.fetch)).company!("732829320")).rejects.toThrow("limite le nombre de demandes");
  });
});

// Shapes trimmed from INPI's documents and a recorded answer, with a made-up company and people.
const person = (nom: string, prenoms: string[], roleEntreprise: string, extra: Record<string, unknown> = {}) => ({
  roleEntreprise,
  typeDePersonne: "INDIVIDU",
  actif: true,
  individu: { descriptionPersonne: { nom, prenoms, dateDeNaissance: "1977-06", genre: "1" }, adresseDomicile: { commune: "LYON" } },
  ...extra,
});

const inpiCompany = (formality: Record<string, unknown> = {}, pouvoirs: unknown[] = []) => ({
  updatedAt: "2026-08-07T13:10:29+02:00",
  id: "63ac5944a863e352a6043d97",
  siren: "732829320",
  formality: {
    siren: "732829320",
    typePersonne: "M",
    diffusionINSEE: "O",
    diffusionCommerciale: true,
    formeJuridique: "5710",
    content: {
      natureCreation: { dateCreation: "2019-03-01", formeJuridique: "5710" },
      personneMorale: {
        identite: { entreprise: { siren: "732829320", denomination: "ACME HOLDING", formeJuridique: "5710", codeApe: "6420Z", dateImmat: "2019-03-01" }, description: { objet: "Prise de participations" } },
        adresseEntreprise: { adresse: { codePays: "FRA", codePostal: "69002", commune: "LYON", typeVoie: "RUE", voie: "DE LA REPUBLIQUE", numVoie: "25" } },
        composition: { pouvoirs },
      },
    },
    ...formality,
  },
});

const attachments = {
  actes: [
    { id: "acte-1", siren: "732829320", dateDepot: "2026-04-11", confidentiality: "Public", deleted: false, nomDocument: "abc", typeRdd: [{ typeActe: "Statuts mis à jour" }, { typeActe: "Décision(s) de l'actionnaire unique", decision: "Modification(s) statutaire(s)" }] },
    { id: "acte-2", siren: "732829320", dateDepot: "2024-05-12", confidentiality: "Public", deleted: true },
  ],
  bilans: [{ id: "bilan-1", siren: "732829320", dateDepot: "2025-11-16", dateCloture: "2024-12-31", typeBilan: "C", confidentiality: "Public", deleted: false }],
  bilansSaisis: [{ id: "saisi-1" }],
};

const logIn = { match: `POST ${INPI}/sso/login`, json: { token: "jwt-1", user: { id: 111111, email: "ada@acme.fr", active: true } } };

describe("the INPI connector", () => {
  it("logs in with the username and password to check them, and names the connection after the account", async () => {
    const { fetch, calls } = fakeFetch([logIn]);

    expect(await inpi(adapterContext({ username: "ada@acme.fr", password: "secret" }, fetch)).check()).toEqual({ ok: true, detail: "Compte INPI ada@acme.fr", label: "ada@acme.fr" });
    expect(JSON.parse(calls[0].body)).toEqual({ username: "ada@acme.fr", password: "secret" });
  });

  it("says when the account is refused", async () => {
    const { fetch } = fakeFetch([{ match: `POST ${INPI}/sso/login`, status: 401, json: { code: "401", webserviceCode: "LOGIN_AUTHENTICATOR", errorCode: "unauthorized", message: "Identifiants invalides.", type: "unauthorized" } }]);

    expect(await inpi(adapterContext({ username: "ada@acme.fr", password: "non" }, fetch)).check()).toEqual({ ok: false, detail: "L’INPI a refusé les identifiants : Identifiants invalides." });
  });

  it("gives who runs the company and what it filed, signed in with its token", async () => {
    const pouvoirs = [person("DUPONT-MARTIN", ["JEANNE", "MARIE"], "73"), { roleEntreprise: "53", typeDePersonne: "ENTREPRISE", actif: true, entreprise: { siren: "900000001", denomination: "ACME PARTICIPATIONS" } }];
    const { fetch, calls } = fakeFetch([logIn, { match: `GET ${INPI}/companies/732829320/attachments`, json: attachments }, { match: `GET ${INPI}/companies/732829320`, json: inpiCompany({}, pouvoirs) }]);

    const company = await inpi(adapterContext({ username: "ada@acme.fr", password: "secret" }, fetch)).company!("732829320");

    expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([`POST ${INPI}/sso/login`, `GET ${INPI}/companies/732829320`, `GET ${INPI}/companies/732829320/attachments`]);
    expect(calls[1].headers.get("authorization")).toBe("Bearer jwt-1");
    expect(company).toEqual({
      siren: "732829320",
      name: "ACME HOLDING",
      facts: {
        registryOptOut: false,
        legalForm: "5710",
        activity: "6420Z",
        registeredOn: "2019-03-01",
        headOffice: { street: "25 RUE DE LA REPUBLIQUE", postcode: "69002", city: "LYON" },
        directors: [
          { kind: "person", firstName: "Jeanne", lastName: "Dupont-Martin", role: "Président", roleCode: "73" },
          { kind: "company", firstName: null, lastName: "ACME PARTICIPATIONS", role: "Directeur général", roleCode: "53", siren: "900000001" },
        ],
        filings: {
          deeds: [{ id: "acte-1", filedOn: "2026-04-11", confidentiality: "Public", kinds: ["Statuts mis à jour", "Décision(s) de l'actionnaire unique"] }],
          annualAccounts: [{ id: "bilan-1", filedOn: "2025-11-16", closedOn: "2024-12-31", kind: "C", confidentiality: "Public" }],
        },
      },
    });
  });

  it("keeps no one's birth date or home, leaves out auditors and former directors, and doesn't guess a role it can't read", async () => {
    const pouvoirs = [person("MARTIN", ["PAUL"], "70"), person("AUDIT", ["EVE"], "71"), person("PARTI", ["LEO"], "30", { actif: false }), { roleEntreprise: "72", typeDePersonne: "ENTREPRISE", entreprise: { denomination: "CABINET AUDIT" } }];
    const { fetch } = fakeFetch([logIn, { match: `GET ${INPI}/companies/732829320/attachments`, json: { actes: [], bilans: [], bilansSaisis: [] } }, { match: `GET ${INPI}/companies/732829320`, json: inpiCompany({}, pouvoirs) }]);

    const company = await inpi(adapterContext({ username: "a", password: "b" }, fetch)).company!("732829320");

    expect(company?.facts.directors).toEqual([{ kind: "person", firstName: "Paul", lastName: "Martin", role: null, roleCode: "70" }]);
    expect(JSON.stringify(company)).not.toMatch(/1977|Naissance/);
  });

  it.each([
    ["diffusionCommerciale is false", { diffusionCommerciale: false }],
    ["diffusionCommerciale is the text False", { diffusionCommerciale: "False" }],
    ["INSEE doesn't let its data be passed on", { diffusionINSEE: "N" }],
  ])("names nobody when the company refused commercial use: %s", async (_, formality) => {
    const { fetch } = fakeFetch([logIn, { match: `GET ${INPI}/companies/732829320/attachments`, json: attachments }, { match: `GET ${INPI}/companies/732829320`, json: inpiCompany(formality, [person("DUPONT", ["JEANNE"], "73")]) }]);

    expect((await inpi(adapterContext({ username: "a", password: "b" }, fetch)).company!("732829320"))?.facts).toMatchObject({ registryOptOut: true, directors: [] });
  });

  it("takes a sole trader as their own director", async () => {
    const answer = { siren: "732829320", formality: { diffusionCommerciale: true, typePersonne: "P", content: { personnePhysique: { identite: { entreprise: { siren: "732829320", codeApe: "6201Z" }, entrepreneur: { descriptionPersonne: { nom: "DUPONT", prenoms: ["JEANNE"], dateDeNaissance: "1977-06" } } } } } } };
    const { fetch } = fakeFetch([logIn, { match: `GET ${INPI}/companies/732829320/attachments`, status: 404, json: {} }, { match: `GET ${INPI}/companies/732829320`, json: answer }]);

    expect(await inpi(adapterContext({ username: "a", password: "b" }, fetch)).company!("732829320")).toMatchObject({
      name: "Jeanne Dupont",
      facts: { directors: [{ kind: "person", firstName: "Jeanne", lastName: "Dupont", role: "Entrepreneur", roleCode: null }], filings: { deeds: [], annualAccounts: [] } },
    });
  });

  it("knows nothing of a company the register doesn't", async () => {
    const { fetch } = fakeFetch([logIn, { match: `GET ${INPI}/companies/`, status: 404, json: {} }]);

    expect(await inpi(adapterContext({ username: "a", password: "b" }, fetch)).company!("732829320")).toBeNull();
  });

  it("logs in again once when its token has expired", async () => {
    let logins = 0;
    let lookups = 0;
    const fetchFake = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (String(input).endsWith("/sso/login")) return Response.json({ token: `jwt-${++logins}` });
      lookups += 1;
      if (new Headers(init.headers).get("authorization") === "Bearer jwt-1") return Response.json({ message: "Expired JWT Token" }, { status: 401 });
      return Response.json(String(input).endsWith("/attachments") ? attachments : inpiCompany());
    }) as typeof fetch;

    const company = await inpi(adapterContext({ username: "a", password: "b" }, fetchFake)).company!("732829320");

    expect(company?.name).toBe("ACME HOLDING");
    expect([logins, lookups]).toEqual([2, 3]);
  });
});

describe("the Google Sheets connector", () => {
  it("checks the token on the userinfo endpoint, and names the connection after the account", async () => {
    const { fetch, calls } = fakeFetch([{ match: `GET ${USERINFO}`, json: { sub: "1", email: "ada@acme.fr", email_verified: true } }]);

    expect(await googleSheets(adapterContext({}, fetch)).check()).toEqual({ ok: true, detail: "Compte Google ada@acme.fr", label: "ada@acme.fr" });
    expect(calls[0].headers.get("authorization")).toBe("Bearer test-access-token");
  });

  it("says when the token is refused", async () => {
    const { fetch } = fakeFetch([{ match: `GET ${USERINFO}`, status: 401, json: { error: "invalid_request", error_description: "Invalid Credentials" } }]);

    expect(await googleSheets(adapterContext({}, fetch)).check()).toEqual({ ok: false, detail: "Google a refusé les identifiants : Invalid Credentials" });
  });

  it("reads the first visible tab by its size when no range is given, and keys each row by the header row", async () => {
    const tabs = { sheets: [{ properties: { hidden: true, gridProperties: { rowCount: 5, columnCount: 2 } } }, { properties: { gridProperties: { rowCount: 1000, columnCount: 26 } } }] };
    const values = {
      range: "Liste d'Anna!A1:Z1000",
      majorDimension: "ROWS",
      values: [
        ["Prénom", " Nom ", "", "Email"],
        ["Jeanne", "Dupont", "ignoré", "jeanne@acme.fr"],
        ["Paul"],
        [],
        ["", "  "],
      ],
    };
    const { fetch, calls } = fakeFetch([{ match: `GET ${SHEETS}/abc/values/`, json: values }, { match: `GET ${SHEETS}/abc`, json: tabs }]);

    const rows = await googleSheets(adapterContext({}, fetch)).rows!("abc");

    expect(new URL(calls[0].url).searchParams.get("fields")).toBe("sheets.properties(hidden,gridProperties(rowCount,columnCount))");
    expect(decodeURIComponent(calls[1].url)).toBe(`${SHEETS}/abc/values/R1C1:R1000C26`);
    expect(rows).toEqual([
      { Prénom: "Jeanne", Nom: "Dupont", Email: "jeanne@acme.fr" },
      { Prénom: "Paul", Nom: "", Email: "" },
    ]);
  });

  it("reads the range it is given, and an empty sheet has no rows", async () => {
    const { fetch, calls } = fakeFetch([{ match: `GET ${SHEETS}/abc/values/`, json: { range: "Prospects!A1:D9", majorDimension: "ROWS" } }]);

    expect(await googleSheets(adapterContext({}, fetch)).rows!("abc", "'Mes prospects'!A1:D9")).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(decodeURIComponent(calls[0].url)).toBe(`${SHEETS}/abc/values/'Mes prospects'!A1:D9`);
  });

  it("has no rows when the spreadsheet has no tab to read", async () => {
    const { fetch } = fakeFetch([{ match: `GET ${SHEETS}/abc`, json: {} }]);

    expect(await googleSheets(adapterContext({}, fetch)).rows!("abc")).toEqual([]);
  });
});
