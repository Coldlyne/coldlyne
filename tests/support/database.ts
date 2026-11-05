import { PGlite } from "@electric-sql/pglite";
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

/** A user, and a workspace they own. */
export async function createTestWorkspace(db: Database, name = "Northwind"): Promise<{ workspaceId: string; userId: string }> {
  const userId = crypto.randomUUID();
  await db.insert(user).values({ id: userId, name: "Ada", email: `${userId}@example.test` });
  return { workspaceId: await createWorkspace(db, userId, name), userId };
}
