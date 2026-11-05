import { CsvError, parse } from "csv-parse/sync";
import { httpsUrl, normalizedEmail, socialProfile } from "./contacts";
import { checkedSiren, checkedSiret, frenchPhoneE164, internationalPhoneE164 } from "./french-numbers";
import { plainLowercase } from "./words";

/**
 * A member's own file of prospects, read as they wrote it: French or English headers, `;` as Excel
 * writes it in France or `,`. A value that can't be read rejects its row, with its line and why,
 * rather than being kept as is or corrected by a guess: the member fixes the file and imports again.
 * The parser's options: https://csv.js.org/parse/options/
 */
export type ProspectField = "firstName" | "lastName" | "email" | "phone" | "company" | "siren" | "siret" | "website" | "role" | "linkedin";

export type ImportedProspect = { line: number } & Record<ProspectField, string | null>;

export interface RejectedRow {
  line: number;
  /** In the member's words. */
  why: string;
}

/** How a header of the file was understood: null when no field matches, and the column is left out. */
export interface ColumnReading {
  header: string;
  field: ProspectField | null;
}

export interface CsvImport {
  rows: ImportedProspect[];
  rejected: RejectedRow[];
  columns: ColumnReading[];
}

/** Headers as written once lowercased, without accents and with their punctuation as spaces. */
const HEADERS: Readonly<Record<ProspectField, readonly string[]>> = {
  firstName: ["prenom", "first name", "firstname", "given name"],
  lastName: ["nom", "nom de famille", "last name", "lastname", "surname", "family name"],
  email: ["email", "e mail", "mail", "courriel", "adresse email", "adresse e mail", "adresse mail", "email address", "email professionnel"],
  phone: ["telephone", "tel", "phone", "phone number", "mobile", "portable", "gsm", "numero de telephone"],
  company: ["entreprise", "societe", "company", "company name", "raison sociale", "denomination", "nom de l entreprise", "nom de la societe"],
  siren: ["siren", "numero siren"],
  siret: ["siret", "numero siret"],
  website: ["site", "site web", "site internet", "website", "web", "url"],
  role: ["fonction", "poste", "role", "job title", "titre du poste"],
  linkedin: ["linkedin", "profil linkedin", "linkedin url", "url linkedin"],
};

const FIELD_OF_HEADER = new Map(Object.entries(HEADERS).flatMap(([field, headers]) => headers.map((header) => [header, field as ProspectField] as const)));

const simplifiedHeader = (header: string) =>
  plainLowercase(header)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const quoted = (value: string) => `«\u00A0${value}\u00A0»`;

/** The field's value in its one stored form, or why it can't be read. */
type Reader = (value: string) => { value: string } | { why: string };

const unchanged: Reader = (value) => ({ value });

const readerOf = (read: (value: string) => string | null | undefined, why: (value: string) => string): Reader => (value) => {
  const normalized = read(value);
  return normalized ? { value: normalized } : { why: why(value) };
};

const READERS: Readonly<Record<ProspectField, Reader>> = {
  firstName: unchanged,
  lastName: unchanged,
  company: unchanged,
  role: unchanged,
  email: readerOf(normalizedEmail, (value) => `l’adresse ${quoted(value)} n’est pas valide`),
  phone: readerOf((value) => frenchPhoneE164(value) ?? internationalPhoneE164(value), (value) => `le téléphone ${quoted(value)} n’est pas un numéro valide`),
  siren: readerOf(checkedSiren, (value) => `le SIREN ${quoted(value)} n’est pas valide`),
  siret: readerOf(checkedSiret, (value) => `le SIRET ${quoted(value)} n’est pas valide`),
  website: readerOf((value) => httpsUrl(value)?.href.replace(/\/$/, ""), (value) => `le site ${quoted(value)} n’est pas une adresse valide`),
  linkedin: readerOf(linkedinProfile, (value) => `le profil LinkedIn ${quoted(value)} n’est pas valide`),
};

function linkedinProfile(value: string): string | null {
  const url = httpsUrl(value);
  const profile = url && socialProfile(url.href);
  return profile?.kind === "linkedin" ? profile.value : null;
}

/** Reads a member's file: what was understood from each header, the rows kept, and the ones refused with why. */
export function readProspectsCsv(text: string): CsvImport {
  let records: CsvRecord[];
  try {
    records = recordsOf(text);
  } catch (error) {
    if (!(error instanceof CsvError)) throw error;
    return { rows: [], rejected: [{ line: typeof error.lines === "number" ? error.lines : 1, why: whyUnreadable(error) }], columns: [] };
  }
  return readRecords(records);
}

/** The same for a spreadsheet's rows, already keyed by their header. */
export function readProspectsSheet(rows: readonly Record<string, string>[]): CsvImport {
  if (rows.length === 0) return { rows: [], rejected: [], columns: [] };
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return readRecords([{ line: 1, cells: headers }, ...rows.map((row, index) => ({ line: index + 2, cells: headers.map((header) => row[header] ?? "") }))]);
}

function readRecords([headers, ...data]: readonly CsvRecord[]): CsvImport {
  if (!headers) return { rows: [], rejected: [], columns: [] };
  const columns = headers.cells.map((header) => ({ header, field: FIELD_OF_HEADER.get(simplifiedHeader(header)) ?? null }));
  if (columns.every(({ field }) => !field)) return { rows: [], rejected: [{ line: headers.line, why: "aucune colonne n’a été reconnue\u00A0: vérifiez la ligne d’en-têtes" }], columns };
  const results = data.map((record) => readRow(record, columns));
  return { rows: results.flatMap((result) => ("row" in result ? result.row : [])), rejected: results.flatMap((result) => ("row" in result ? [] : result)), columns };
}

/** A misplaced quote hides where every later cell starts, so the file is refused whole rather than read wrongly. */
const whyUnreadable = ({ code }: CsvError) => `${code === "CSV_QUOTE_NOT_CLOSED" ? "un guillemet ouvert plus haut n’est jamais refermé" : "des guillemets sont mal fermés sur cette ligne"}\u00A0: le fichier n’a pas pu être lu`;

interface CsvRecord {
  line: number;
  cells: string[];
}

/** The file's records and the line each starts on, for the member to find it again. */
function recordsOf(text: string): CsvRecord[] {
  const parsed = parse(text, {
    bom: true,
    delimiter: delimiterOf(text),
    info: true,
    trim: true,
    relax_quotes: true,
    relax_column_count: true,
    skip_empty_lines: true,
    skip_records_with_empty_values: true,
  }) as unknown as { record: string[]; info: { lines: number } }[];
  return parsed.map(({ record, info }) => ({ cells: record, line: info.lines - record.join("").split("\n").length + 1 }));
}

/** Which of `;` and `,` the header line uses, not counting those inside quotes. */
function delimiterOf(text: string): ";" | "," {
  const headerLine = text.replace(/^﻿/, "").trimStart().split(/\r?\n/, 1)[0];
  const outsideQuotes = headerLine.replace(/"[^"]*"/g, "");
  const count = (delimiter: string) => outsideQuotes.split(delimiter).length - 1;
  return count(";") > count(",") ? ";" : ",";
}

const EMPTY_PROSPECT: Readonly<Record<ProspectField, null>> = { firstName: null, lastName: null, email: null, phone: null, company: null, siren: null, siret: null, website: null, role: null, linkedin: null };

/** A row kept or refused. When two columns give the same field ("Téléphone", "Mobile"), the first one filled wins. */
function readRow({ line, cells }: CsvRecord, columns: readonly ColumnReading[]): { row: ImportedProspect } | RejectedRow {
  const fields: Record<ProspectField, string | null> = { ...EMPTY_PROSPECT };
  const faults: string[] = [];
  columns.forEach(({ field }, index) => {
    const cell = (cells[index] ?? "").replace(/\s+/g, " ").trim();
    if (!field || !cell || fields[field]) return;
    const read = READERS[field](cell);
    if ("why" in read) faults.push(read.why);
    else fields[field] = read.value;
  });
  // A row whose only contact detail is misspelled shouldn't also be told it has none.
  if (!faults.length) faults.push(...faultsAcrossFields(fields));
  return faults.length ? { line, why: faults.join("\u202F; ") } : { row: { line, ...fields, siren: fields.siren ?? fields.siret?.slice(0, 9) ?? null } };
}

function faultsAcrossFields(fields: Readonly<Record<ProspectField, string | null>>): string[] {
  const { siren, siret, lastName, company, email, phone, linkedin } = fields;
  if (siren && siret && !siret.startsWith(siren)) return [`le SIRET ${quoted(siret)} n’appartient pas au SIREN ${quoted(siren)}`];
  return lastName || company || siren || siret || email || phone || linkedin ? [] : ["ni nom, ni entreprise, ni moyen de contact"];
}

/** A sheet's id, from its id or from the address a member copied from their browser. */
export const spreadsheetIdOf = (given: string) => given.trim().match(/\/spreadsheets\/d\/([\w-]+)/)?.[1] ?? given.trim();
