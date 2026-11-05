import { createHmac } from "node:crypto";
import { sameSecret } from "@/infrastructure/crypto/secrets";

/** The secret the member pastes in the provider's console: the `token` of their signed address. */
export function hookSecret(hookUrl: string): string {
  const token = new URL(hookUrl).searchParams.get("token");
  // An empty key would let anyone sign: never verify without one.
  if (!token) throw new Error("L’adresse de ce webhook n’a pas de jeton.");
  return token;
}

/** Whether a signature is the HMAC-SHA256, in hex, of what the provider says it signed. */
export const signatureMatches = (secret: string, signed: string, signature: string) => sameSecret(createHmac("sha256", secret).update(signed).digest("hex"), signature);
