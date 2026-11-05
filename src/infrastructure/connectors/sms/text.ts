/**
 * The text of an SMS as a provider wants it. The application ends each text with how to stop, but
 * the number to stop to belongs to the provider: each adapter takes that mention off and has the
 * provider's own put on instead, so it is always there, always right, and never doubled.
 */

/** "STOP au 36111", "STOP 36034", "Répondre STOP au 36111.", "STOP SMS", at the very end of a text. */
const STOP_MENTION = /(?:^|\s+)(?:r[ée]pond(?:re|ez)\s+)?stop(?:\s+sms)?(?:\s+au)?(?:\s+(?:\d{3,6}|\[stop_code\]|x{3,}))?\s*[.!]?\s*$/iu;

export const withoutStopMention = (text: string) => text.replace(STOP_MENTION, "").trimEnd();

/** The GSM 03.38 alphabet with its extension: most French accents are in it, but not ê, î, ô, û, ç or ’. */
const GSM7 = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€\f]*$/u;

/**
 * Whether a text fits the SMS alphabet. Outside it a provider garbles the letters or needs Unicode,
 * which shortens each SMS from 160 to 70 characters, so Unicode is only asked for when needed.
 */
export const fitsGsm7 = (text: string) => GSM7.test(text);

/** E.164 without its plus, as Brevo's and smsmode's docs write a recipient. */
export const withoutPlus = (to: string) => to.replace(/^\+/, "");

/** What a check says of an account's SMS credits, in whole credits. */
export function creditsLeft(credits: number): string {
  const whole = Math.max(0, Math.floor(credits));
  const plural = whole > 1 ? "s" : "";
  return `${new Intl.NumberFormat("fr-FR").format(whole)} crédit${plural} SMS restant${plural}`;
}
