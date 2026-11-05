/**
 * France's phone and company numbers, in the one form the rest of Coldlyne keeps them: a phone in
 * E.164, a SIREN as nine checked digits. What can't be read as one is refused, never guessed.
 */

/**
 * The overseas departments dial with their own country code and keep their local prefix: 0692 12
 * 34 56 becomes +262 692 12 34 56, not +33. Prefixes from ARCEP's numbering plan:
 * https://www.arcep.fr/la-regulation/grands-dossiers-thematiques-transverses/la-numerotation/la-numerotation-outre-mer.html
 */
const OVERSEAS_COUNTRY_CODES: Readonly<Record<string, string>> = {
  "262": "262",
  "263": "262",
  "269": "262",
  "639": "262",
  "692": "262",
  "693": "262",
  "590": "590",
  "690": "590",
  "691": "590",
  "594": "594",
  "694": "594",
  "596": "596",
  "696": "596",
  "697": "596",
};

const MAINLAND_OR_NATIONAL = /^(?:(?:\+|00)33)?0?([1-9]\d{8})$/;
const OVERSEAS_INTERNATIONAL = /^(?:\+|00)(262|590|594|596)0?([1-9]\d{8})$/;

const withoutDialPunctuation = (text: string) => text.replace(/[\s.()/-]/g, "");
const withoutSeparators = (text: string) => text.replace(/[\s.-]/g, "");

/** A French number in any usual writing ("01 23 45 67 89", "+33 (0)1…", "0033 1…") as E.164, or null. */
export function frenchPhoneE164(text: string): string | null {
  const dialed = withoutDialPunctuation(text.replace(/\(0\)/g, ""));
  const overseas = OVERSEAS_INTERNATIONAL.exec(dialed);
  if (overseas) return `+${overseas[1]}${overseas[2]}`;
  // Nine digits with no prefix at all may be anything: only a leading 0 or +33 says it's French.
  if (!/^(?:\+|00|0)/.test(dialed)) return null;
  const national = MAINLAND_OR_NATIONAL.exec(dialed)?.[1];
  if (!national) return null;
  const countryCode = OVERSEAS_COUNTRY_CODES[national.slice(0, 3)] ?? "33";
  return `+${countryCode}${national}`;
}

/** A foreign number already written in E.164 ("+44 20 7946 0958"), for a list that has a few. */
export function internationalPhoneE164(text: string): string | null {
  const dialed = withoutDialPunctuation(text);
  return /^\+[1-9]\d{7,14}$/.test(dialed) ? dialed : null;
}

/** The Luhn check that SIREN numbers carry in their last digit. */
function passesLuhn(digits: string): boolean {
  const sum = [...digits].reverse().reduce((total, digit, position) => {
    const value = Number(digit) * (position % 2 === 1 ? 2 : 1);
    return total + (value > 9 ? value - 9 : value);
  }, 0);
  return sum % 10 === 0;
}

/** A SIREN in any writing ("732 829 320") as nine digits, or null when it isn't one. */
export function checkedSiren(text: string): string | null {
  const digits = withoutSeparators(text);
  return /^\d{9}$/.test(digits) && passesLuhn(digits) ? digits : null;
}

/**
 * A SIRET in any writing as fourteen digits, or null. Only its SIREN part is checked: La Poste's
 * establishments share one SIREN and their SIRETs don't pass Luhn as a whole.
 */
export function checkedSiret(text: string): string | null {
  const digits = withoutSeparators(text);
  return /^\d{14}$/.test(digits) && checkedSiren(digits.slice(0, 9)) ? digits : null;
}
