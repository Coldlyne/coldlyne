import { describe, expect, it } from "vitest";
import { fromRegistry, prospectable } from "@/domain/registry";
import { companiesBySiren, companiesDirectedBy, searchRegistry } from "@/infrastructure/registry/client";
import { holding } from "./support/registry";

/** A fetch that answers this body, and remembers the addresses asked. */
function stubFetch(body: unknown, status = 200) {
  const asked: URL[] = [];
  const fetchUrl = async (url: string) => {
    asked.push(new URL(url));
    return new Response(JSON.stringify(body), { status });
  };
  return { asked, fetchUrl };
}

describe("a company from the registry", () => {
  it("is who it is, what it does and where, and the people and companies who run it, without their birth dates", () => {
    expect(fromRegistry(holding())).toEqual({
      siren: "900000001",
      name: "ACME HOLDING",
      legalForm: "5710",
      activity: "64.20Z",
      street: null,
      postcode: "69002",
      city: "LYON",
      createdOn: "2019-03-01",
      active: true,
      registryOptOut: false,
      directors: [
        { kind: "person", firstName: "Jeanne", lastName: "Dupont-Martin", role: "Président de SAS" },
        { kind: "company", firstName: null, lastName: "ACME PARTICIPATIONS", role: "Directeur général" },
      ],
    });
  });

  it("isn't prospected when it refused commercial use of its data, or is closed", () => {
    expect(prospectable(fromRegistry(holding()))).toBe(true);
    expect(prospectable(fromRegistry(holding("1", { opposition_diffusion_commerciale: true })))).toBe(false);
    expect(prospectable(fromRegistry(holding("1", { etat_administratif: "C" })))).toBe(false);
  });
});

describe("searching the registry", () => {
  it("asks for active companies with these activities, legal forms, place and size, a page at a time", async () => {
    const { asked, fetchUrl } = stubFetch({ results: [holding()], total_results: 7182, page: 2, total_pages: 288 });

    const page = await searchRegistry({ activities: ["64.20Z"], legalForms: ["5710", "5499"], department: "69", sizes: ["NN", "00"], page: 2 }, fetchUrl);

    expect(Object.fromEntries(asked[0].searchParams)).toEqual({ etat_administratif: "A", per_page: "25", page: "2", activite_principale: "64.20Z", nature_juridique: "5710,5499", departement: "69", tranche_effectif_salarie: "NN,00" });
    expect(page).toMatchObject({ total: 7182, page: 2, pages: 288, companies: [{ siren: "900000001", name: "ACME HOLDING" }] });
  });

  it("counts the active companies a person directs", async () => {
    const { asked, fetchUrl } = stubFetch({ results: [], total_results: 4 });

    expect(await companiesDirectedBy("Jeanne", "Dupont-Martin", fetchUrl)).toBe(4);
    expect(Object.fromEntries(asked[0].searchParams)).toMatchObject({ type_personne: "dirigeant", nom_personne: "Dupont-Martin", prenoms_personne: "Jeanne" });
  });

  it("says when the registry refuses, and that too many requests can be tried again", async () => {
    await expect(searchRegistry({}, stubFetch({}, 429).fetchUrl)).rejects.toThrow("limite le nombre de demandes");
  });
});

describe("looking companies up by SIREN", () => {
  const answers = (statuses: number[]) => {
    const calls: string[] = [];
    const fetchUrl = async (url: string) => {
      calls.push(url);
      const status = statuses.shift() ?? 200;
      return new Response(JSON.stringify({ results: [holding("900000001")], total_results: 1 }), { status });
    };
    return { calls, fetchUrl };
  };

  it("waits when the registry asks, then carries on", async () => {
    const { calls, fetchUrl } = answers([429, 200]);
    const found = await companiesBySiren(["900000001"], fetchUrl);
    expect(found.get("900000001")?.name).toBe("ACME HOLDING");
    expect(calls).toHaveLength(2);
  });

  it("gives up after three tries, saying why", async () => {
    const { calls, fetchUrl } = answers([429, 429, 429]);
    await expect(companiesBySiren(["900000001"], fetchUrl)).rejects.toThrow("limite le nombre de demandes");
    expect(calls).toHaveLength(3);
  });

  it("doesn't wait on any other refusal", async () => {
    const { calls, fetchUrl } = answers([500]);
    await expect(companiesBySiren(["900000001"], fetchUrl)).rejects.toThrow("a répondu 500");
    expect(calls).toHaveLength(1);
  });

  it("leaves time between lookups", async () => {
    const { fetchUrl } = answers([]);
    const started = Date.now();
    await companiesBySiren(["900000001", "900000002", "900000003"], fetchUrl);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  });
});
