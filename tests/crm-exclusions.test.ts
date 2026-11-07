import { describe, expect, it } from "vitest";
import { companyIsExcluded, exclusionsOf, replyNote, type OffLimitsEntry } from "@/domain/crm-exclusions";
import { expectFrenchTypography } from "./support/french";

const entry = (overrides: Partial<OffLimitsEntry> = {}): OffLimitsEntry => ({ company: null, people: [], ...overrides });
const someone = (overrides: Partial<OffLimitsEntry["people"][number]> = {}) => ({ emails: [], phones: [], linkedinUrl: null, ...overrides });

describe("what a CRM's customers and open deals become", () => {
  it("is the form Coldlyne keeps each in: an address, a number, a profile, a domain, a SIREN, a name", () => {
    const values = exclusionsOf([
      entry({
        company: { name: "ACME Holding SAS", domain: "ACME.example", siren: "732 829 320" },
        people: [someone({ emails: [" Ada@ACME.example "], phones: ["06 12 34 56 78"], linkedinUrl: "https://www.linkedin.com/in/Ada/?utm=x" })],
      }),
    ]);
    expect(values).toEqual(expect.arrayContaining(["ada@acme.example", "+33612345678", "https://www.linkedin.com/in/ada", "acme.example", "siren:732829320", "company:acme holding"]));
    expect(values).toHaveLength(6);
  });

  it("keeps each once, however many deals say so", () => {
    const person = someone({ emails: ["ada@acme.example"] });
    expect(exclusionsOf([entry({ people: [person] }), entry({ people: [person, person] })])).toEqual(["ada@acme.example"]);
  });

  it("never takes a mail provider's domain or something unreadable, which would stop strangers", () => {
    const values = exclusionsOf([
      entry({ company: { name: "S.A.S.", domain: "gmail.com", siren: "123" }, people: [someone({ emails: ["not an address"], phones: ["pas un numéro"], linkedinUrl: "https://acme.example/ada" })] }),
      entry({ company: { name: "Beta", domain: "com", siren: null } }),
    ]);
    expect(values).toEqual(["company:beta"]);
  });

  it("takes a foreign number written in full", () => {
    expect(exclusionsOf([entry({ people: [someone({ phones: ["+44 20 7946 0958"] })] })])).toEqual(["+442079460958"]);
  });
});

describe("a company on the list", () => {
  const LIST = new Set(["acme.example", "siren:732829320", "company:acme holding"]);
  const company = (overrides = {}) => ({ name: "Other", siren: null, website: null, ...overrides });

  it("is known by its site, its SIREN or its name, however its name is written", () => {
    expect(companyIsExcluded(company({ website: "https://www.acme.example/contact" }), LIST)).toBe(true);
    expect(companyIsExcluded(company({ siren: "732829320" }), LIST)).toBe(true);
    expect(companyIsExcluded(company({ name: "Acmé HOLDING, sarl" }), LIST)).toBe(true);
  });

  it("isn't another with a similar name or site", () => {
    expect(companyIsExcluded(company({ name: "Acme Holding Europe", website: "https://acme.example.org" }), LIST)).toBe(false);
    expect(companyIsExcluded(company(), LIST)).toBe(false);
  });
});

describe("what a reply says in the CRM", () => {
  it("names the channel and keeps what they wrote, within what a note holds", () => {
    expectFrenchTypography(replyNote("email", "Volontiers"));
    expect(replyNote("email", "Volontiers")).toBe("A répondu par Email : Volontiers");
    expect(replyNote("linkedin", null)).toBe("A répondu par LinkedIn.");
    expect(replyNote("email", "x".repeat(9000)).length).toBeLessThanOrEqual(4100);
  });
});
