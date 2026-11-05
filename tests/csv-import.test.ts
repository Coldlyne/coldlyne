import { describe, expect, it } from "vitest";
import { readProspectsCsv, spreadsheetIdOf } from "@/domain/csv-import";
import { checkedSiren, checkedSiret, frenchPhoneE164 } from "@/domain/french-numbers";

const headersAndRow = (headers: string, row: string) => readProspectsCsv(`${headers}\n${row}\n`);

describe("reading a file of prospects", () => {
  it("reads what Excel writes in France: semicolons, a BOM, French headers", () => {
    const { rows, rejected, columns } = readProspectsCsv("﻿Prénom;Nom;Société;Téléphone;Fonction\r\nJeanne;Dupont;ACME, SAS;06 12 34 56 78;Présidente\r\n");

    expect(rejected).toEqual([]);
    expect(rows).toEqual([{ line: 2, firstName: "Jeanne", lastName: "Dupont", email: null, phone: "+33612345678", company: "ACME, SAS", siren: null, siret: null, website: null, role: "Présidente", linkedin: null }]);
    expect(columns).toEqual([
      { header: "Prénom", field: "firstName" },
      { header: "Nom", field: "lastName" },
      { header: "Société", field: "company" },
      { header: "Téléphone", field: "phone" },
      { header: "Fonction", field: "role" },
    ]);
  });

  it("reads commas and English headers, and says which columns it left out", () => {
    const { rows, columns } = readProspectsCsv('First name,Last Name,E-mail,Company,Website,Job Title,LinkedIn,Budget\nAda,Lovelace,ADA@Acme.FR,"Acme; Inc",acme.fr,CEO,linkedin.com/in/ada-lovelace/,10000\n');

    expect(rows[0]).toMatchObject({ firstName: "Ada", lastName: "Lovelace", email: "ada@acme.fr", company: "Acme; Inc", website: "https://acme.fr", role: "CEO", linkedin: "https://www.linkedin.com/in/ada-lovelace" });
    expect(columns.at(-1)).toEqual({ header: "Budget", field: null });
  });

  it.each([
    ["prénom", "firstName"],
    ["PRENOM", "firstName"],
    ["first name", "firstName"],
    ["nom", "lastName"],
    ["last name", "lastName"],
    ["Courriel", "email"],
    ["Adresse e-mail", "email"],
    ["téléphone", "phone"],
    ["phone", "phone"],
    ["Mobile", "phone"],
    ["entreprise", "company"],
    ["société", "company"],
    ["company", "company"],
    ["SIREN", "siren"],
    ["Siret", "siret"],
    ["site", "website"],
    ["Site web", "website"],
    ["website", "website"],
    ["fonction", "role"],
    ["poste", "role"],
    ["rôle", "role"],
    ["linkedin", "linkedin"],
    ["Profil LinkedIn", "linkedin"],
  ])("understands the header %s", (header, field) => {
    expect(readProspectsCsv(`${header};Nom complet\nx;y\n`).columns[0]).toEqual({ header, field });
  });

  it("derives the SIREN from a SIRET when that's all there is", () => {
    expect(headersAndRow("Nom;SIRET", "Dupont;732 829 320 00012").rows[0]).toMatchObject({ siret: "73282932000012", siren: "732829320" });
  });

  it("takes the first filled column when two give the same field", () => {
    expect(headersAndRow("Nom;Téléphone;Mobile", "Dupont;;06 12 34 56 78").rows[0].phone).toBe("+33612345678");
    expect(headersAndRow("Nom;Téléphone;Mobile", "Dupont;01 23 45 67 89;06 12 34 56 78").rows[0].phone).toBe("+33123456789");
  });

  it("keeps a foreign number written in full, and tidies spaces inside a cell", () => {
    expect(headersAndRow("Nom;Tel", "  Dupont   Martin ;+44 20 7946 0958").rows[0]).toMatchObject({ lastName: "Dupont Martin", phone: "+442079460958" });
  });

  it("makes every site https", () => {
    expect(headersAndRow("Nom;Site", "Dupont;http://www.acme.fr/").rows[0].website).toBe("https://www.acme.fr");
    expect(headersAndRow("Nom;Site", "Dupont;WWW.ACME.FR/equipe").rows[0].website).toBe("https://www.acme.fr/equipe");
  });

  it("reports each refused row with its line and why, in French, and keeps the others", () => {
    const { rows, rejected } = readProspectsCsv(
      ["Prénom;Nom;Email;Téléphone;SIREN;SIRET;Site;LinkedIn", "Ok;Un;un@acme.fr;;;;;", ";;jeanne@;;;;;", ";Deux;;12 34;;;;", ";Trois;;;123456789;;;", ";Quatre;;;;123;;", ";Cinq;;;;;pas un site;", ";Six;;;;;;https://example.com/ada", "Prénom seul;;;;;;;"].join("\n"),
    );

    expect(rows.map(({ line, lastName }) => [line, lastName])).toEqual([[2, "Un"]]);
    expect(rejected).toEqual([
      { line: 3, why: "l’adresse «\u00A0jeanne@\u00A0» n’est pas valide" },
      { line: 4, why: "le téléphone «\u00A012 34\u00A0» n’est pas un numéro valide" },
      { line: 5, why: "le SIREN «\u00A0123456789\u00A0» n’est pas valide" },
      { line: 6, why: "le SIRET «\u00A0123\u00A0» n’est pas valide" },
      { line: 7, why: "le site «\u00A0pas un site\u00A0» n’est pas une adresse valide" },
      { line: 8, why: "le profil LinkedIn «\u00A0https://example.com/ada\u00A0» n’est pas valide" },
      { line: 9, why: "ni nom, ni entreprise, ni moyen de contact" },
    ]);
  });

  it("gives every reason a row is refused, at once", () => {
    expect(headersAndRow("Nom;Email;SIREN", "Dupont;x@;1").rejected[0].why).toBe("l’adresse «\u00A0x@\u00A0» n’est pas valide\u202F; le SIREN «\u00A01\u00A0» n’est pas valide");
  });

  it("refuses a SIRET that isn't the SIREN's", () => {
    expect(headersAndRow("Nom;SIREN;SIRET", "Dupont;732829320;35600000000048").rejected[0].why).toBe("le SIRET «\u00A035600000000048\u00A0» n’appartient pas au SIREN «\u00A0732829320\u00A0»");
  });

  it("counts lines as the file does, past empty lines and cells on several lines", () => {
    const { rows, rejected } = readProspectsCsv('Nom;Fonction;Email\n\nUn;;\n"Deux";"Présidente\net fondatrice";\n\n\nTrois;;x@\n;;\n');

    expect(rows.map(({ line, role }) => [line, role])).toEqual([
      [3, null],
      [4, "Présidente et fondatrice"],
    ]);
    expect(rejected.map(({ line }) => line)).toEqual([8]);
  });

  it("reads a row shorter or longer than the headers", () => {
    expect(readProspectsCsv("Nom;Email\nDupont\nMartin;m@acme.fr;en trop\n").rows.map(({ lastName, email }) => [lastName, email])).toEqual([
      ["Dupont", null],
      ["Martin", "m@acme.fr"],
    ]);
  });

  it("keeps a stray quote inside a cell", () => {
    expect(headersAndRow("Nom;Entreprise", 'Dupont;ACME "Holding"').rows[0].company).toBe('ACME "Holding"');
  });

  it("says when the file can't be read at all", () => {
    expect(readProspectsCsv('Nom;Entreprise\nDupont;"ACME\nMartin;BETA\n')).toEqual({ rows: [], rejected: [{ line: 3, why: "un guillemet ouvert plus haut n’est jamais refermé\u00A0: le fichier n’a pas pu être lu" }], columns: [] });
  });

  it("refuses the file at the line where text follows a closing quote, rather than read the rest wrongly", () => {
    expect(readProspectsCsv('Nom;Entreprise\nUn;A\n"Dupont" Martin;ACME\nDeux;B\n')).toEqual({ rows: [], rejected: [{ line: 3, why: "des guillemets sont mal fermés sur cette ligne\u00A0: le fichier n’a pas pu être lu" }], columns: [] });
  });

  it("says when no header means anything, rather than refusing every row", () => {
    const { rows, rejected, columns } = readProspectsCsv("Colonne A;Colonne B\n1;2\n3;4\n");

    expect(rows).toEqual([]);
    expect(rejected).toEqual([{ line: 1, why: "aucune colonne n’a été reconnue\u00A0: vérifiez la ligne d’en-têtes" }]);
    expect(columns).toEqual([
      { header: "Colonne A", field: null },
      { header: "Colonne B", field: null },
    ]);
  });

  it("has nothing to say about an empty file", () => {
    expect(readProspectsCsv("")).toEqual({ rows: [], rejected: [], columns: [] });
    expect(readProspectsCsv("﻿\n\n")).toEqual({ rows: [], rejected: [], columns: [] });
  });
});

describe("a sheet's id", () => {
  it.each([
    ["1aB-c_D", "1aB-c_D"],
    ["  1aB-c_D ", "1aB-c_D"],
    ["https://docs.google.com/spreadsheets/d/1aB-c_D/edit#gid=0", "1aB-c_D"],
  ])("reads %s", (given, id) => {
    expect(spreadsheetIdOf(given)).toBe(id);
  });
});

describe("French numbers", () => {
  it.each([
    ["01 23 45 67 89", "+33123456789"],
    ["01.23.45.67.89", "+33123456789"],
    ["01-23-45-67-89", "+33123456789"],
    ["0123456789", "+33123456789"],
    ["+33 1 23 45 67 89", "+33123456789"],
    ["+33 (0)1 23 45 67 89", "+33123456789"],
    ["+33 0 1 23 45 67 89", "+33123456789"],
    ["0033 1 23 45 67 89", "+33123456789"],
    ["01\u00A023\u202F45 67 89", "+33123456789"],
    ["0692 12 34 56", "+262692123456"],
    ["0590 12 34 56", "+590590123456"],
    ["+596 696 12 34 56", "+596696123456"],
    ["+33 6 94 12 34 56", "+594694123456"],
  ])("reads %s as %s", (written, e164) => {
    expect(frenchPhoneE164(written)).toBe(e164);
  });

  it.each(["612345678", "12 34", "+44 20 7946 0958", "00 44 20 7946 0958", "01 23 45 67", "00 23 45 67 89", "", "numéro"])("doesn't take %s for a French number", (written) => {
    expect(frenchPhoneE164(written)).toBeNull();
  });

  it("checks a SIREN's last digit", () => {
    expect(checkedSiren("732 829 320")).toBe("732829320");
    expect(checkedSiren("356000000")).toBe("356000000");
    expect(checkedSiren("732829321")).toBeNull();
    expect(checkedSiren("12345678")).toBeNull();
  });

  it("checks a SIRET by its SIREN, since La Poste's don't pass as a whole", () => {
    expect(checkedSiret("356 000 000 00048")).toBe("35600000000048");
    expect(checkedSiret("73282932100012")).toBeNull();
    expect(checkedSiret("7328293200001")).toBeNull();
  });
});
