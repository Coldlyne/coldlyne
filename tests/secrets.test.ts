import { describe, expect, it } from "vitest";
import { open, randomToken, sameSecret, seal, sha256 } from "@/infrastructure/crypto/secrets";

const KEY = Buffer.alloc(32, 7).toString("base64");

describe("sealed credentials", () => {
  it("opens what it sealed, and shows nothing of it in the sealed text", () => {
    const sealed = seal({ apiKey: "very-secret-value" }, KEY);
    expect(sealed).not.toContain("very-secret-value");
    expect(open(sealed, KEY)).toEqual({ apiKey: "very-secret-value" });
  });

  it("seals the same credentials differently each time", () => {
    expect(seal({ apiKey: "a" }, KEY)).not.toBe(seal({ apiKey: "a" }, KEY));
  });

  it("refuses a tampered text, another key, and a missing or short key", () => {
    const sealed = seal({ apiKey: "a" }, KEY);
    const parts = sealed.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => open(parts.join("."), KEY)).toThrow();
    expect(() => open(sealed, Buffer.alloc(32, 8).toString("base64"))).toThrow();
    expect(() => seal({}, undefined)).toThrow(/COLDLYNE_SECRETS_KEY/);
    expect(() => seal({}, Buffer.alloc(16).toString("base64"))).toThrow(/COLDLYNE_SECRETS_KEY/);
    expect(() => open("v9.a.b.c", KEY)).toThrow(/format/);
  });

  it("makes tokens, hashes and compares in constant time", () => {
    expect(randomToken()).not.toBe(randomToken());
    expect(sha256("a")).toHaveLength(64);
    expect(sameSecret("abc", "abc")).toBe(true);
    expect(sameSecret("abc", "abd")).toBe(false);
    expect(sameSecret("abc", "abcd")).toBe(false);
  });
});
