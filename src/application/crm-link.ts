import { and, eq, isNull, notInArray, or, sql } from "drizzle-orm";
import { exclusionsOf, replyNote } from "@/domain/crm-exclusions";
import type { Channel } from "@/domain/sequences";
import type { Database } from "@/infrastructure/db/client";
import { crmPush } from "@/infrastructure/db/schema/connections";
import { prospect, suppression } from "@/infrastructure/db/schema/prospects";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { pushToCrm } from "./contacts";
import { addToSuppressionList, ownSuppression, stopAtExcludedCompanies, stopExcludedAt } from "./enrollments";
import type { LinkedCrm } from "./ports";
import { lastReply } from "./replies";
import type { Services } from "./services";

/**
 * A CRM linked both ways, on each sync. Who replied goes there; who it holds as customers and open
 * deals comes back as exclusions of this workspace. Neither contacts anyone.
 */

/** How many people one sync hands over: the rest wait for the next, so a first read of a long history doesn't run out of time. */
const MOST_PER_SYNC = 50;
/** A CRM refusing this many in a row isn't refusing one person: the rest can wait for it to answer. */
const MOST_REFUSALS = 3;
/** Someone a member read as neither wanting this nor the right person isn't a deal. */
const NOT_A_DEAL = ["not_interested", "wrong_person"] as const;

/**
 * Who this CRM says is off limits goes on the workspace's list. Nothing comes off when they leave the
 * CRM, or when the connection goes: a customer deleted by mistake mustn't be prospected the same day,
 * and a lost deal only comes back by someone's decision. What's new stops what's running, calls and
 * messages waiting for a member included. Says how many are new.
 */
async function keepOffLimits(services: Services, workspaceId: string, read: LinkedCrm["offLimits"]): Promise<number> {
  const values = exclusionsOf(await read());
  return withWorkspace(services.db, workspaceId, async (tx) => {
    const known = new Set((await tx.select({ value: suppression.value }).from(suppression).where(ownSuppression)).map(({ value }) => value));
    const fresh = values.filter((value) => !known.has(value));
    if (fresh.length === 0) return 0;
    await addToSuppressionList(tx, fresh.map((value) => ({ value, reason: "crm" as const })));
    for (const value of fresh) await stopExcludedAt(tx, value);
    await stopAtExcludedCompanies(tx);
    return fresh.length;
  });
}

/** Those who replied and aren't in this CRM yet, the longest waiting first, with what they said. What they wrote is data, there as here. */
async function waitingToGo(db: Database, workspaceId: string, connectionId: string) {
  return withWorkspace(db, workspaceId, async (tx) => {
    const rows = await tx
      .select({ prospectId: prospect.id, personId: prospect.personId })
      .from(prospect)
      .where(
        and(
          eq(prospect.state, "replied"),
          or(isNull(prospect.interest), notInArray(prospect.interest, [...NOT_A_DEAL])),
          sql`not exists (select 1 from ${crmPush} where ${crmPush.connectionId} = ${connectionId} and ${crmPush.prospectId} = ${prospect.id})`,
        ),
      )
      .orderBy(prospect.updatedAt)
      .limit(MOST_PER_SYNC);
    return Promise.all(rows.map(async ({ personId, prospectId }) => ({ prospectId, ...(await lastReply(tx, personId, prospectId)) })));
  });
}

/** Hands over who's waiting: what the CRM refuses stays waiting for the next sync, and the connection says why. Says how many went. */
async function handOverReplies(services: Services, workspaceId: string, connectionId: string): Promise<number> {
  let handedOver = 0;
  let refusals = 0;
  let lastRefusal = "";
  for (const { prospectId, lastChannel, lastDetail } of await waitingToGo(services.db, workspaceId, connectionId)) {
    const channel = (lastChannel ?? "email") as Channel;
    const pushed = await pushToCrm(services, workspaceId, connectionId, prospectId, replyNote(channel, lastDetail), channel);
    if (pushed.ok) handedOver += 1;
    else {
      lastRefusal = pushed.error;
      refusals += 1;
      if (refusals >= MOST_REFUSALS) break;
    }
  }
  if (lastRefusal) throw new Error(lastRefusal);
  return handedOver;
}

export interface LinkSynced {
  excluded: number;
  handedOver: number;
}

/** One sync of a linked CRM. Exclusions first, so a CRM refusing a person doesn't keep its customers from being known. Throws what its service said. */
export async function syncLinkedCrm(services: Services, workspaceId: string, connectionId: string, read: LinkedCrm["offLimits"]): Promise<LinkSynced> {
  const excluded = await keepOffLimits(services, workspaceId, read);
  return { excluded, handedOver: await handOverReplies(services, workspaceId, connectionId) };
}
