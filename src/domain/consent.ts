/**
 * Where an assistant's access would go, read from the address its request was signed for: the one
 * thing on the consent screen that isn't the assistant's own say-so. Parsed as a browser parses it, so
 * `https://claude.ai@elsewhere.example` reads as elsewhere.example. Null when it can't be told.
 */
export function whereAccessGoes(redirectUri: unknown): string | null {
  if (typeof redirectUri !== "string" || !URL.canParse(redirectUri)) return null;
  const { protocol, host } = new URL(redirectUri);
  return protocol === "https:" || protocol === "http:" ? host : `${protocol}${host && `//${host}`}`;
}
