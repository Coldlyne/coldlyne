import type { RegistryApiCompany } from "@/domain/registry";

/** A made-up holding as the registry API returns it: a person and a company among its directors. */
export const holding = (siren = "900000001", overrides: Partial<RegistryApiCompany> = {}): RegistryApiCompany => ({
  siren,
  nom_complet: "ACME HOLDING",
  nature_juridique: "5710",
  activite_principale: "64.20Z",
  etat_administratif: "A",
  date_creation: "2019-03-01",
  opposition_diffusion_commerciale: false,
  siege: { code_postal: "69002", libelle_commune: "LYON" },
  dirigeants: [
    { type_dirigeant: "personne physique", nom: "DUPONT-MARTIN", prenoms: "JEANNE MARIE", qualite: "Président de SAS" },
    { type_dirigeant: "personne morale", denomination: "ACME PARTICIPATIONS", qualite: "Directeur général" },
  ],
  ...overrides,
});
