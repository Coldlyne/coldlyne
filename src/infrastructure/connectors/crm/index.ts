import type { Adapter } from "../adapter";
import { axonaut } from "./axonaut";
import { folk } from "./folk";
import { hubspot } from "./hubspot";
import { nocrm } from "./nocrm";
import { pipedrive } from "./pipedrive";
import { sellsy } from "./sellsy";
import { soldlyne } from "./soldlyne";

/** The crm connectors, by kind. */
export const crmAdapters: Record<string, Adapter> = { hubspot, pipedrive, sellsy, axonaut, nocrm, folk, soldlyne };
