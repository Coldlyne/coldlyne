import type { Adapter } from "../adapter";
import { googleSheets } from "./google-sheets";
import { inpi } from "./inpi";
import { sirene } from "./sirene";

/** The sources connectors, by kind. */
export const sourcesAdapters: Record<string, Adapter> = {
  sirene,
  inpi,
  google_sheets: googleSheets,
};
