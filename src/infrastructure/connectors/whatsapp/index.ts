import type { Adapter } from "../adapter";
import { whatsappCloudAdapter } from "./cloud";

/** The whatsapp connectors, by kind. */
export const whatsappAdapters: Record<string, Adapter> = {
  whatsapp_cloud: whatsappCloudAdapter,
};
