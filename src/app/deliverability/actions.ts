"use server";

import { publishRecord, type Tried } from "@/application/connection-use";
import type { DnsRecord } from "@/domain/deliverability";
import { currentSeat } from "@/infrastructure/auth/session";
import { appServices } from "@/infrastructure/services";

/** Publishes a record the check listed, through a DNS the workspace connected. */
export async function publishAction(connectionId: string, domain: string, record: DnsRecord): Promise<Tried> {
  const seat = await currentSeat();
  return publishRecord(appServices(), seat.workspaceId, connectionId, domain, record);
}
