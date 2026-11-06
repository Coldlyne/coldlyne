import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { DRIZZLE_CASING, schema, type Database } from "@/infrastructure/db/client";
import { user } from "@/infrastructure/db/schema/auth";
import { createWorkspace } from "@/application/workspaces";

/** A real Postgres, in-process, with Coldlyne's migrations applied. */
export async function createTestDatabase(): Promise<Database> {
  const db = drizzle(new PGlite(), { schema, casing: DRIZZLE_CASING }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "src/infrastructure/db/migrations" });
  return db;
}

const MIGRATIONS = "src/infrastructure/db/migrations";

/** How many migrations came before the directory. */
const BEFORE_DIRECTORY = 10;

/**
 * A database at the last migration before the directory, holding the rows of a deployment that has
 * been in use, and what applies the rest: this is how the directory's migration meets real data.
 */
export async function databaseBeforeDirectory(): Promise<{ db: Database; finishMigrating: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema, casing: DRIZZLE_CASING }) as unknown as Database;
  const internals = db as unknown as { dialect: { migrate: (migrations: unknown[], session: unknown, config: unknown) => Promise<void> }; session: unknown };
  await internals.dialect.migrate(readMigrationFiles({ migrationsFolder: MIGRATIONS }).slice(0, BEFORE_DIRECTORY), internals.session, { migrationsFolder: MIGRATIONS });
  await client.exec(readFileSync("tests/support/before-directory.sql", "utf8"));
  return { db, finishMigrating: () => migrate(db as never, { migrationsFolder: MIGRATIONS }) };
}

/** The rows of a raw query, whichever driver answered. */
export const rowsOf = (result: unknown) => (Array.isArray(result) ? result : (result as { rows: Record<string, unknown>[] }).rows) as Record<string, unknown>[];

/** A user, and a workspace they own. */
export async function createTestWorkspace(db: Database, name = "Northwind"): Promise<{ workspaceId: string; userId: string }> {
  const userId = crypto.randomUUID();
  await db.insert(user).values({ id: userId, name: "Ada", email: `${userId}@example.test` });
  return { workspaceId: await createWorkspace(db, userId, name), userId };
}
