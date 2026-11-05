/** Applies pending database migrations: pnpm db:migrate */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { z } from "zod";

/** Neon's pooler refuses some session settings: migrations go through its direct endpoint, the unpooled URL when there is one. */
function databaseUrl(): string {
  const url = z.url().parse(process.env.COLDLYNE_DATABASE_URL_UNPOOLED ?? process.env.COLDLYNE_DATABASE_URL);
  return url.replace("-pooler.", ".");
}

async function main() {
  const client = postgres(databaseUrl(), { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder: "src/infrastructure/db/migrations" });
    console.log("Migrations applied");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
