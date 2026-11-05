import { sql } from "drizzle-orm";
import type { Database } from "./client";
import { appRole } from "./schema/shared";

/**
 * Runs work in one transaction, as the restricted app role (it cannot bypass row-level security),
 * bound to a workspace. Row-level security then limits every statement to that workspace's rows.
 * Both settings are transaction-local, so a pooled connection never leaks them.
 */
export function withWorkspace<T>(db: Database, workspaceId: string, work: (tx: Database) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true), set_config('role', ${appRole.name}, true)`);
    return work(tx);
  });
}
