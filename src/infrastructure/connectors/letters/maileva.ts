import type { PostalAddress } from "@/application/ports";
import type { Adapter } from "../adapter";
import { checked } from "../checked";
import { bearerJson, requestJson } from "../http";
import { cachedToken } from "./token";

/**
 * Maileva (La Poste), its mail API. A letter is a sending built in four steps: created, its
 * document added, its recipient added, submitted. A submitted sending can't be cancelled.
 *
 * Sandbox: https://connexion.sandbox.maileva.net/auth/realms/services/protocol/openid-connect/token
 *          and https://api.sandbox.maileva.net/mail/v3
 *
 * Docs: https://www.maileva.com/catalogue-api/mail-v3/ (https://www.maileva.com/app/uploads/2026/01/openapi-mail-v3-2.yaml)
 *       https://www.maileva.com/catalogue-api/authentification/ (https://www.maileva.com/app/uploads/2023/09/api-authentication-v2-1b.yaml)
 *       https://www.maileva.com/changelog/
 */

const TOKEN_URL = "https://connexion.maileva.com/auth/realms/services/protocol/openid-connect/token";
const API = "https://api.maileva.com/mail/v3";
const PROVIDER = "Maileva";
/** The longest address line Maileva accepts, and the postal standard's (NF Z10-011). */
const LINE_LENGTH = 38;

/**
 * Printed in black and white, one side, posted as "Courant" (J+3), the equivalent of a green
 * letter. The paid address sheet is asked for because the place of the address on a letter's own
 * first page isn't documented: a sheet can't overprint the letter, and costs one more page.
 */
const SIMPLE_LETTER = { color_printing: false, duplex_printing: false, optional_address_sheet: true, envelope_windows_type: "SIMPLE", postage_type: "FAST" };

export const maileva: Adapter = (context) => {
  const { clientId, clientSecret, username, password } = context.fields;
  const token = cachedToken(context.now, async () => {
    const body = new URLSearchParams({ grant_type: "password", username, password, client_id: clientId, client_secret: clientSecret });
    const answer = await requestJson<{ access_token: string; expires_in: number }>(context.fetch, PROVIDER, TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body });
    return { token: answer.access_token, expiresAt: new Date(context.now().getTime() + answer.expires_in * 1000) };
  });
  const send = async <Answer>(method: string, path: string, body?: unknown) =>
    requestJson<Answer>(context.fetch, PROVIDER, `${API}${path}`, { method, headers: bearerJson(await token()), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  return {
    check: () =>
      checked(PROVIDER, async () => {
        const { paging } = await send<{ paging?: { total_results?: number } }>("GET", "/sendings?count=1");
        const sendings = paging?.total_results ?? 0;
        return { ok: true, label: username, detail: sendings ? `${sendings} envoi${sendings > 1 ? "s" : ""} sur ce compte` : "Aucun envoi pour le moment" };
      }),
    async postLetter(letter) {
      const customId = letter.reference.slice(0, 36);
      const sender = { ...addressLines(letter.from, "sender_address_line"), sender_country_code: letter.from.country };
      const sending = await send<{ id: string }>("POST", "/sendings", { name: letter.reference, custom_id: customId, ...SIMPLE_LETTER, ...sender });
      // No content type here: the runtime writes the multipart boundary itself.
      const uploadHeaders = { authorization: `Bearer ${await token()}`, accept: "application/json" };
      await requestJson(context.fetch, PROVIDER, `${API}/sendings/${sending.id}/documents`, { method: "POST", headers: uploadHeaders, body: documentForm(letter.pdf, `${customId}.pdf`) });
      await send("POST", `/sendings/${sending.id}/recipients`, { custom_id: customId, ...addressLines(letter.to, "address_line"), country_code: letter.to.country });
      // A 2xx means it is leaving, whatever its body: an unreadable one mustn't look like a failure and post it twice.
      await send("POST", `/sendings/${sending.id}/submit`).catch((error: unknown) => {
        if (!(error instanceof SyntaxError)) throw error;
      });
      return { externalId: sending.id };
    },
  };
};

/** The PDF and its metadata, each part with its own type, which Maileva requires. */
function documentForm(pdf: Uint8Array, name: string): FormData {
  const form = new FormData();
  form.append("document", new Blob([pdf.slice()], { type: "application/octet-stream" }), name);
  form.append("metadata", new Blob([JSON.stringify({ priority: 1, name })], { type: "application/json" }));
  return form;
}

/**
 * An address on Maileva's six lines: 1 the company, 2 the person, 3 the building, 4 the street,
 * 5 the rest (lieu-dit, BP), 6 the postcode and city. Over 38 characters a line is cut rather than
 * have the whole letter refused for a long company name.
 */
function addressLines(address: PostalAddress, prefix: "address_line" | "sender_address_line"): Record<string, string> {
  const lines = [address.company, address.name, ...streetLines(address.lines), `${address.postcode} ${address.city.toUpperCase()}`];
  return Object.fromEntries(lines.flatMap((line, index) => (line ? [[`${prefix}_${index + 1}`, line.slice(0, LINE_LENGTH)]] : [])));
}

/** Lines 3 to 5 from an address's lines: a single one is the street, on line 4. */
function streetLines(lines: string[]): [string | undefined, string | undefined, string | undefined] {
  if (lines.length < 2) return [undefined, lines[0], undefined];
  const [building, street, ...rest] = lines;
  return [building, street, rest.join(" ") || undefined];
}
