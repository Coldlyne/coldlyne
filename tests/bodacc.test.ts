import { describe, expect, it } from "vitest";
import { bodaccWhere, fromBodacc, type BodaccApiRecord } from "@/domain/bodacc";
import { searchBodacc } from "@/infrastructure/bodacc/client";
import { fakeFetch } from "./support/fetch";

const API = "https://bodacc-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/annonces-commerciales/records";

/** Records trimmed from the real API's answers, with made-up companies and people. */
const creation: BodaccApiRecord = {
  id: "A20260212771",
  familleavis: "creation",
  familleavis_lib: "Créations",
  dateparution: "2026-11-04",
  commercant: "ACME HOLDING",
  ville: "Lyon",
  numerodepartement: "69",
  registre: ["732829320", "732 829 320"],
  url_complete: "https://www.bodacc.fr/pages/annonces-commerciales-detail/?q.id=id:A20260212771",
  listepersonnes: JSON.stringify({ personne: { typePersonne: "pm", numeroImmatriculation: { numeroIdentification: "732 829 320", codeRCS: "RCS", nomGreffeImmat: "Lyon" }, denomination: "ACME HOLDING", formeJuridique: "Société par Actions Simplifiée" } }),
  listeetablissements: JSON.stringify({ etablissement: { activite: "Holding, prise de participations.", adresse: { codePostal: "69002", ville: "Lyon" } } }),
  acte: JSON.stringify({ dateCommencementActivite: "2026-10-01", creation: { categorieCreation: "Immatriculation d'une personne morale suite à création" } }),
};

describe("the query sent to BODACC", () => {
  it("asks for initial notices of the families worth prospecting from, when nothing narrows it", () => {
    expect(bodaccWhere({})).toBe('typeavis="annonce" AND familleavis in ("creation","immatriculation","modification","vente","radiation","collective")');
  });

  it("narrows by family, publication dates, department and words", () => {
    expect(bodaccWhere({ families: ["creation", "immatriculation"], publishedFrom: "2026-10-26", publishedTo: "2026-11-01", department: "69", words: "holding" })).toBe(
      `typeavis="annonce" AND familleavis in ("creation","immatriculation") AND dateparution>=date'2026-10-26' AND dateparution<=date'2026-11-01' AND numerodepartement="69" AND search("holding")`,
    );
  });

  it("finds director changes, which BODACC words as a change of administration", () => {
    expect(bodaccWhere({ families: ["modification"], onlyDirectorChanges: true })).toBe('typeavis="annonce" AND familleavis in ("modification") AND modificationsgenerales like "administration"');
  });

  it("keeps words from a conversation inside their quotes", () => {
    expect(bodaccWhere({ words: 'x") OR ("1"="1', department: 'a\\"' })).toContain(String.raw`numerodepartement="a\\\"" AND search("x\") OR (\"1\"=\"1")`);
  });

  it("refuses a date it would have to write into the query unchecked", () => {
    expect(() => bodaccWhere({ publishedFrom: "2026-11-01' OR '1'='1" })).toThrow("Date attendue au format AAAA-MM-JJ");
  });
});

describe("an announcement from BODACC", () => {
  it("is what happened, to which company, where and when, and where to read it", () => {
    expect(fromBodacc(creation)).toEqual([
      {
        id: "A20260212771",
        family: "creation",
        publishedOn: "2026-11-04",
        sirens: ["732829320"],
        companyName: "ACME HOLDING",
        city: "Lyon",
        department: "69",
        summary: "Immatriculation d'une personne morale suite à création — Holding, prise de participations.",
        url: "https://www.bodacc.fr/pages/annonces-commerciales-detail/?q.id=id:A20260212771",
      },
    ]);
  });

  it("names both sides of a sale, with the buyer as the company", () => {
    const sale: BodaccApiRecord = {
      id: "A20260212777",
      familleavis: "vente",
      dateparution: "2026-11-04",
      commercant: "ACME LAVERIE, EURL BETA",
      ville: "Neyron, Val-d'Oingt",
      numerodepartement: "69",
      registre: ["732829320", "732 829 320", "356000000", "356 000 000"],
      listepersonnes: JSON.stringify({ personne: { typePersonne: "pm", denomination: "ACME LAVERIE" } }),
      listeprecedentproprietaire: JSON.stringify({ personne: { typePersonne: "pm", denomination: "EURL BETA" } }),
      acte: JSON.stringify({ descriptif: "Adresse de l'ancien propriétaire : 1 rue Dupont.", vente: { categorieVente: "Achat d'un établissement principal par une personne morale" } }),
    } as BodaccApiRecord;

    expect(fromBodacc(sale)[0]).toMatchObject({ sirens: ["732829320", "356000000"], companyName: "ACME LAVERIE", summary: "Achat d'un établissement principal par une personne morale" });
  });

  it("says a director change in BODACC's words", () => {
    const change = { id: "B1", familleavis: "modification", dateparution: "2026-11-04", commercant: "ACME", modificationsgenerales: '{"descriptif": "Modification de l\'administration."}' };

    expect(fromBodacc(change)[0].summary).toBe("Modification de l'administration.");
  });

  it("leaves a judgment's free text out, since it names people", () => {
    const judgment = { id: "A1", familleavis: "collective", familleavis_lib: "Procédures collectives", dateparution: "2026-11-04", commercant: "ACME", jugement: JSON.stringify({ famille: "Extrait de jugement", nature: "Jugement de clôture pour insuffisance d'actif", complementJugement: "à l'encontre de M. Jean Dupont" }) };

    expect(fromBodacc(judgment)[0].summary).toBe("Jugement de clôture pour insuffisance d'actif");
  });

  it("calls a sole trader by their trade name, and a removal by its family when nothing says more", () => {
    const removal = { id: "B2", familleavis: "radiation", familleavis_lib: "Radiations", dateparution: "2026-11-04", commercant: "DUPONT, Jeanne", listepersonnes: JSON.stringify({ personne: { typePersonne: "pp", nom: "DUPONT", prenom: "Jeanne", nomCommercial: "ACME CONSEIL" } }), radiationaurcs: JSON.stringify({ dateCessationActivitePP: "2026-09-30" }) };

    expect(fromBodacc(removal)[0]).toMatchObject({ companyName: "ACME CONSEIL", summary: "Radiations" });
  });

  it("copes with what has no number or no details, a co-ownership for one", () => {
    const coOwnership = { id: "A2", familleavis: "collective", dateparution: "2026-11-04", registre: null, commercant: null, listepersonnes: "pas du JSON", ville: null };

    expect(fromBodacc(coOwnership)).toEqual([{ id: "A2", family: "collective", publishedOn: "2026-11-04", sirens: [], companyName: null, city: null, department: null, summary: null, url: null }]);
  });

  it("reads a number written as text, and leaves out families Coldlyne doesn't prospect from", () => {
    expect(fromBodacc({ ...creation, registre: "732 829 320,732829320" })[0].sirens).toEqual(["732829320"]);
    expect(fromBodacc({ ...creation, familleavis: "dpc" })).toEqual([]);
  });
});

describe("searching BODACC", () => {
  it("asks for a page, the latest first, and says how many match and how many pages can be read", async () => {
    const { fetch, calls } = fakeFetch([{ match: `GET ${API}`, json: { total_count: 941, results: [creation] } }]);

    const page = await searchBodacc({ families: ["creation"], department: "69", page: 3 }, fetch);

    expect(Object.fromEntries(new URL(calls[0].url).searchParams)).toEqual({ where: 'typeavis="annonce" AND familleavis in ("creation") AND numerodepartement="69"', order_by: "dateparution desc, id desc", limit: "25", offset: "50" });
    expect(page).toMatchObject({ total: 941, page: 3, pages: 38, announcements: [{ id: "A20260212771", sirens: ["732829320"] }] });
  });

  it("counts only the pages the API lets one reach", async () => {
    const { fetch } = fakeFetch([{ match: `GET ${API}`, json: { total_count: 3_501_658, results: [] } }]);

    expect(await searchBodacc({}, fetch)).toEqual({ announcements: [], total: 3_501_658, page: 1, pages: 400 });
  });

  it("says when BODACC refuses a query, in its words", async () => {
    const { fetch } = fakeFetch([{ match: `GET ${API}`, status: 400, json: { error_code: "ODSQLSyntaxError", message: "ODSQL syntax exception" } }]);

    await expect(searchBodacc({}, fetch)).rejects.toThrow("Le BODACC a refusé la demande : ODSQL syntax exception");
  });
});
