import { describe, expect, it } from "vitest";
import { CATEGORY_NAMES, CONNECTORS, connectorOf, isConnectorKind, readFields, type Connector } from "@/domain/connectors";

describe("the connector catalogue", () => {
  it("names each kind once, and every category has a name", () => {
    const kinds = CONNECTORS.map((connector) => connector.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const connector of CONNECTORS) expect(CATEGORY_NAMES[connector.category]).toBeTruthy();
  });

  it("finds a connector by its kind", () => {
    expect(connectorOf("gmail")?.name).toBe("Google Workspace");
    expect(connectorOf("nope")).toBeUndefined();
    expect(isConnectorKind("smtp")).toBe(true);
    expect(isConnectorKind("nope")).toBe(false);
  });

  it("never asks for a secret in a field shown in clear", () => {
    const secretWords = /password|secret|token|apikey|consumerkey/i;
    for (const connector of CONNECTORS as readonly Connector[]) {
      if (connector.authorization.kind !== "fields") continue;
      for (const field of connector.authorization.fields) if (secretWords.test(field.key)) expect(field.secret, `${connector.kind}.${field.key}`).toBe(true);
    }
  });
});

describe("reading what a member typed", () => {
  const smtp = connectorOf("smtp") as Connector;

  it("says which required fields are missing, by their label", () => {
    const read = readFields(smtp, { address: "ada@acme.fr", smtpHost: "  " });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.missing).toEqual(expect.arrayContaining(["Serveur SMTP", "Mot de passe"]));
  });

  it("trims values, skips optional ones left empty, and keeps nothing unknown", () => {
    const read = readFields(smtp, { address: " ada@acme.fr ", smtpHost: "h", smtpPort: "465", imapHost: "h", imapPort: "993", password: "p", displayName: "", extra: "ignored" });
    expect(read).toEqual({ ok: true, values: { address: "ada@acme.fr", smtpHost: "h", smtpPort: "465", imapHost: "h", imapPort: "993", password: "p" } });
  });

  it("asks nothing of a connector that signs in or receives", () => {
    expect(readFields(connectorOf("gmail") as Connector, {})).toEqual({ ok: true, values: {} });
    expect(readFields(connectorOf("signups") as Connector, {})).toEqual({ ok: true, values: {} });
  });
});
