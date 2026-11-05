import { eq, inArray } from "drizzle-orm";
import { CONNECTORS, type Capability } from "@/domain/connectors";
import type { Database } from "@/infrastructure/db/client";
import { connection } from "@/infrastructure/db/schema/connections";
import { sequence, watchlist } from "@/infrastructure/db/schema/sequences";
import { POLLED } from "./signals";

export interface ScheduledWork {
  /** A sequence is running: the 15-minute job has someone to write to. */
  sending: boolean;
  /** A mailbox or a calendar is connected, working or not: the hourly job has something to read. */
  reading: boolean;
  /** A watch exists: the daily job has something to look for. */
  watching: boolean;
}

const READ_KINDS = CONNECTORS.filter(({ capabilities }) => (capabilities as readonly Capability[]).some((capability) => POLLED.includes(capability))).map(({ kind }) => kind);

/** What the scheduled jobs have to do, across every workspace. Trusted path: it only ever says yes or no. */
export async function whatIsScheduled(db: Database): Promise<ScheduledWork> {
  const [running] = await db.select({ id: sequence.id }).from(sequence).where(eq(sequence.status, "running")).limit(1);
  const [reader] = await db.select({ id: connection.id }).from(connection).where(inArray(connection.kind, READ_KINDS)).limit(1);
  const [watch] = await db.select({ id: watchlist.id }).from(watchlist).limit(1);
  return { sending: Boolean(running), reading: Boolean(reader), watching: Boolean(watch) };
}
