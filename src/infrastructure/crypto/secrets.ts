import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Seals a connection's credentials (AES-256-GCM) with the instance's secrets key, so a database
 * dump alone reveals none of them. The version prefix leaves room to rotate the key: a new
 * version seals new rows while the old one still opens the rest.
 */

const VERSION = "v1";

export type Credentials = Record<string, string>;

function keyFrom(base64: string | undefined): Buffer {
  const key = Buffer.from(base64 ?? "", "base64");
  if (key.length !== 32) throw new Error("COLDLYNE_SECRETS_KEY must be 32 random bytes, base64 (openssl rand -base64 32).");
  return key;
}

export function seal(credentials: Credentials, base64Key: string | undefined): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(base64Key), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function open(sealed: string, base64Key: string | undefined): Credentials {
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || !body) throw new Error("These credentials were sealed in a format this version of Coldlyne can't open.");
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(base64Key), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8"));
}

/** A random token, URL-safe: API keys, webhook tokens, OAuth states. */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Compares two strings in constant time, so a wrong token's timing says nothing about the right one. */
export function sameSecret(a: string, b: string): boolean {
  const [left, right] = [Buffer.from(a), Buffer.from(b)];
  return left.length === right.length && timingSafeEqual(left, right);
}
