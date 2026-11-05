/** A little before a token's expiry, so a call never starts with one about to lapse. */
const MARGIN_MS = 30_000;

/** A provider's access token, asked for once and kept until shortly before it expires. */
export function cachedToken(now: () => Date, ask: () => Promise<{ token: string; expiresAt: Date }>): () => Promise<string> {
  let current: { token: string; expiresAt: Date } | undefined;
  return async () => {
    if (!current || now().getTime() >= current.expiresAt.getTime() - MARGIN_MS) current = await ask();
    return current.token;
  };
}
