import type { Adapter } from "../adapter";
import { maileva } from "./maileva";
import { merciFacteur } from "./merci-facteur";

/** The letters connectors, by kind. */
export const lettersAdapters: Record<string, Adapter> = {
  merci_facteur: merciFacteur,
  maileva,
};
