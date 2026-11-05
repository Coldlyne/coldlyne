import { sql } from "drizzle-orm";
import { pgPolicy, pgRole, timestamp, uuid } from "drizzle-orm/pg-core";

// What the tables of every area share: their timestamps, the app role and its tenant policy.

export const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
export const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ─── Tenant isolation ──────────────────────────────────────────────────────
//
// A workspace's data is read and written under the restricted role `coldlyne_app`, with the
// workspace set per transaction (see tenant.ts). Row-level security then hides every other
// workspace's rows, even from a query that forgets to filter. `app_workspace_id()` is defined in
// the migration that creates the role.

export const appRole = pgRole("coldlyne_app").existing();

const currentWorkspace = sql`app_workspace_id()`;

export function tenantIsolation(column = "workspace_id") {
  const check = sql`${sql.identifier(column)} = ${currentWorkspace}`;
  return pgPolicy("tenant_isolation", { for: "all", to: appRole, using: check, withCheck: check });
}

/** The workspace a row belongs to, filled from the transaction's workspace when left out. */
export const workspaceColumn = () => uuid().notNull().default(sql`app_workspace_id()`);
