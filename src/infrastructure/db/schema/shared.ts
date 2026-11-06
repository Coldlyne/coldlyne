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

// ─── The directory ─────────────────────────────────────────────────────────
//
// What a group of workspaces holds in common (see tenancy.ts). `app_directory_id()` is the bound
// workspace's directory, read from the database and never from a setting, so a transaction can only
// reach the directory of the workspace it is bound to. Written as a subquery so that a statement
// reads it once, rather than once per row.

export const currentDirectory = sql`(select app_directory_id())`;

/** Every workspace of the directory may read and write these rows. */
export function directoryIsolation(column = "directory_id") {
  const check = sql`${sql.identifier(column)} = ${currentDirectory}`;
  return pgPolicy("directory_isolation", { for: "all", to: appRole, using: check, withCheck: check });
}

/** A workspace's own row that others of its directory may read: it can only be written into its own directory. */
export function tenantIsolationInDirectory() {
  const own = sql`"workspace_id" = ${currentWorkspace}`;
  return pgPolicy("tenant_isolation", { for: "all", to: appRole, using: own, withCheck: sql`${own} and "directory_id" = ${currentDirectory}` });
}

/** The workspace a row belongs to, filled from the transaction's workspace when left out. */
export const workspaceColumn = () => uuid().notNull().default(sql`app_workspace_id()`);
