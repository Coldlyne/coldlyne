import { desc, eq, and, inArray } from "drizzle-orm";
import type { Database } from "@/infrastructure/db/client";
import { outreach, signal } from "@/infrastructure/db/schema/connections";
import { contactDetail } from "@/infrastructure/db/schema/prospects";
import { enrollment } from "@/infrastructure/db/schema/sequences";

/** The addresses someone is known by, for finding what came from them. */
export async function addressesOf(tx: Database, personId: string, prospectId: string): Promise<string[]> {
  const details = await tx.select({ value: contactDetail.value }).from(contactDetail).where(eq(contactDetail.personId, personId));
  const reached = await tx
    .selectDistinct({ address: outreach.address })
    .from(outreach)
    .innerJoin(enrollment, eq(enrollment.id, outreach.enrollmentId))
    .where(eq(enrollment.prospectId, prospectId));
  return [...new Set([...details.map((row) => row.value), ...reached.map((row) => row.address)])];
}

/** The last thing someone said, through which channel: what a reply, a booking or a STOP came to. */
export async function lastReply(tx: Database, personId: string, prospectId: string) {
  const addresses = await addressesOf(tx, personId, prospectId);
  if (addresses.length === 0) return { lastAt: null, lastDetail: null, lastChannel: null };
  const [last] = await tx
    .select({ lastAt: signal.at, lastDetail: signal.detail, lastChannel: signal.channel })
    .from(signal)
    .where(and(inArray(signal.address, addresses), inArray(signal.type, ["replied", "meeting_booked", "opted_out"])))
    .orderBy(desc(signal.at))
    .limit(1);
  return last ?? { lastAt: null, lastDetail: null, lastChannel: null };
}
