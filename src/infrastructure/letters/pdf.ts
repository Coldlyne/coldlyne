import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import type { PostalAddress } from "@/application/ports";
import type { SenderIdentity } from "@/domain/sequences";

/**
 * A one-page letter, laid out for a French window envelope: the sender top left, the recipient where
 * the window shows it. Print-and-post services take the PDF as it is.
 */

const MM = 72 / 25.4;
const PAGE = { width: 210 * MM, height: 297 * MM };
const MARGIN = 20 * MM;
const WINDOW = { x: 110 * MM, fromTop: 50 * MM };
const BODY_FROM_TOP = 95 * MM;
const SIZE = 11;
const SMALL = 8;
const LINE = 15;

/** The standard fonts only cover Western European characters: anything else (an emoji) would stop the letter. */
const printable = (text: string) => text.replace(/ /g, " ").replace(/[^\n\x20-\x7e -ÿ‘’“”–—…€Œœ]/g, "");

function wrapped(text: string, font: PDFFont, size: number, width: number): string[] {
  return printable(text)
    .split("\n")
    .flatMap((paragraph) => {
      const lines: string[] = [];
      let current = "";
      for (const word of paragraph.split(" ")) {
        const candidate = current ? `${current} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) <= width) current = candidate;
        else {
          lines.push(current);
          current = word;
        }
      }
      lines.push(current);
      return lines;
    });
}

function drawLines(page: PDFPage, lines: readonly string[], font: PDFFont, x: number, top: number, size = SIZE, height = LINE): number {
  lines.forEach((line, index) => page.drawText(printable(line), { x, y: PAGE.height - top - index * height, size, font }));
  return top + lines.length * height;
}

const addressLines = (address: PostalAddress) => [address.name, ...(address.company ? [address.company] : []), ...address.lines, `${address.postcode} ${address.city}`];

export async function letterPdf(letter: { from: PostalAddress; to: PostalAddress; body: string; footer: string }): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([PAGE.width, PAGE.height]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  drawLines(page, addressLines(letter.from), font, MARGIN, MARGIN);
  drawLines(page, addressLines(letter.to), font, WINDOW.x, WINDOW.fromTop);
  drawLines(page, wrapped(letter.body, font, SIZE, PAGE.width - 2 * MARGIN), font, MARGIN, BODY_FROM_TOP);
  const footer = wrapped(letter.footer, font, SMALL, PAGE.width - 2 * MARGIN);
  drawLines(page, footer, font, MARGIN, PAGE.height - MARGIN - footer.length * (SMALL + 2), SMALL, SMALL + 2);
  return pdf.save();
}

/** "12 rue de la Paix, 75002 Paris" as the address a service needs, or null when it can't be read that way. */
export function parsedPostalAddress(sender: SenderIdentity): PostalAddress | null {
  const match = sender.address.match(/^([\s\S]+?)[,\s]+(\d{5})\s+([\s\S]+)$/);
  return match ? { name: sender.name, lines: [match[1].trim()], postcode: match[2], city: match[3].trim(), country: "FR" } : null;
}

export function postalAddressOf(sender: SenderIdentity): PostalAddress {
  const parsed = parsedPostalAddress(sender);
  if (!parsed) throw new Error("L’adresse de l’expéditeur doit se terminer par un code postal et une ville : corrigez-la dans les Réglages.");
  return parsed;
}
