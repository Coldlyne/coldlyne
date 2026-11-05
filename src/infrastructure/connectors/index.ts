import type { ConnectorKind } from "@/domain/connectors";
import type { Adapter } from "./adapter";
import { automationAdapters } from "./automation";
import { calendarsAdapters } from "./calendars";
import { crmAdapters } from "./crm";
import { deliverabilityAdapters } from "./deliverability";
import { emailAdapters } from "./email";
import { lettersAdapters } from "./letters";
import { smsAdapters } from "./sms";
import { sourcesAdapters } from "./sources";
import { telephonyAdapters } from "./telephony";
import { whatsappAdapters } from "./whatsapp";

const adapters: Record<string, Adapter> = {
  ...sourcesAdapters,
  ...emailAdapters,
  ...smsAdapters,
  ...lettersAdapters,
  ...telephonyAdapters,
  ...whatsappAdapters,
  ...calendarsAdapters,
  ...crmAdapters,
  ...automationAdapters,
  ...deliverabilityAdapters,
};

/** The adapter that talks to a connector's service. */
export function adapterOf(kind: ConnectorKind): Adapter {
  const adapter = adapters[kind];
  if (!adapter) throw new Error(`No adapter for the connector "${kind}" yet.`);
  return adapter;
}
