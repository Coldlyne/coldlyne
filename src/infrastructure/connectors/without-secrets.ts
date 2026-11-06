const HIDDEN = "[masqué]";
const LONGEST = 200;

const ADDRESS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

/** What reads like a credential: after a word for one, after an auth scheme, a key's prefix with a digit in what follows, or a long unbroken run. */
const CREDENTIAL_SHAPES = [
  /\b[\w-]*(?:key|token|secret|password|signature)[\w-]*["']?\s*[=:]\s*["']?[^\s"'&,;]{8,}/gi,
  /\b(?:bearer|basic)\s+\S{8,}/gi,
  /\b[a-z]{2,8}_(?=[\w-]*\d)[\w-]{8,}/gi,
  /[A-Za-z0-9+/_-]{24,}={0,2}/g,
];

/** Which server an address points at, and no more: its path and its query can hold a key. */
function serverOf(address: string): string {
  if (!URL.canParse(address)) return HIDDEN;
  const { origin } = new URL(address);
  return origin === "null" ? HIDDEN : origin;
}

/**
 * A service's words, fit to keep and to show: what it answers can quote what it was sent, and this
 * reaches members, assistants and the database. `sent` is what this very request carried.
 */
export function withoutSecrets(text: string, sent: readonly string[] = []): string {
  const unquoted = sent.reduce((said, secret) => said.replaceAll(secret, HIDDEN), text);
  return CREDENTIAL_SHAPES.reduce((said, shape) => said.replace(shape, HIDDEN), unquoted.replace(ADDRESS, serverOf)).slice(0, LONGEST);
}
