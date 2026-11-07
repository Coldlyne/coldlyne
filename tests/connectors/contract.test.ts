import { describe, expect, it } from "vitest";
import { CONNECTORS, type Capability, type Connector } from "@/domain/connectors";
import { adapterOf } from "@/infrastructure/connectors";
import type { AdapterClient } from "@/infrastructure/connectors/adapter";
import { adapterContext, fakeFetch } from "../support/fetch";

/** The method each capability promises, so the catalogue can't list what its adapter doesn't do. */
const METHODS: Record<Capability, (keyof AdapterClient)[]> = {
  find_companies: ["company"],
  read_sheet: ["rows"],
  send_email: ["sendEmail"],
  read_replies: ["signalsSince"],
  send_sms: ["sendSms"],
  post_letter: ["postLetter"],
  place_call: ["placeCall"],
  call_events: ["readWebhook"],
  send_whatsapp: ["sendTemplate"],
  meetings: ["meetingsSince"],
  push_contacts: ["pushContact"],
  linked_crm: ["offLimits"],
  notify: ["notify"],
  reputation: ["reputation"],
  dns_records: ["records", "upsertRecord"],
  signups: ["readWebhook"],
};

describe("every connector in the catalogue", () => {
  const client = (connector: Connector) => adapterOf(connector.kind)(adapterContext({ address: "ada@acme.fr" }, fakeFetch([]).fetch));

  it.each((CONNECTORS as readonly Connector[]).map((connector) => [connector.kind, connector] as const))("%s has an adapter that does what it promises", (_, connector) => {
    const adapter = client(connector);
    expect(typeof adapter.check).toBe("function");
    for (const capability of connector.capabilities) for (const method of METHODS[capability]) expect(typeof adapter[method], `${capability}: ${String(method)}`).toBe("function");
    if (connector.webhooks) expect(typeof adapter.readWebhook, "it posts back, so it must read what it posts").toBe("function");
  });
});
