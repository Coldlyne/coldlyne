/**
 * A phone number in E.164, whatever the provider's format ("+33 1 76 11 11 11", "33176111111"),
 * since signals are matched to prospects by it. Null when it isn't one: "anonymous", a national
 * number ("01 76 11 11 11") whose country can't be told.
 */
export function e164(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/[\s().-]/g, "").replace(/^\+/, "");
  return /^[1-9]\d{6,14}$/.test(digits) ? `+${digits}` : null;
}
