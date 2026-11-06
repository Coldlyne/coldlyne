import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { keepParametersOutOfQueryErrors } from "@/infrastructure/db/query-errors";
import type { Database } from "@/infrastructure/db/client";
import { createTestDatabase } from "./support/database";

const SESSION_TOKEN = "a-session-token-nobody-should-log";

describe("a query that fails", () => {
  let db: Database;

  beforeAll(async () => {
    keepParametersOutOfQueryErrors();
    db = await createTestDatabase();
  });

  it("says its statement and why, and never its parameters", async () => {
    const failed = await db.execute(sql`select * from no_such_table where token = ${SESSION_TOKEN}`).then(
      () => null,
      (error: Error) => error,
    );
    expect(failed).toBeInstanceOf(Error);
    expect(failed?.message).toContain("no_such_table");
    expect(failed?.message).not.toContain(SESSION_TOKEN);
    expect((failed as Error & { params: unknown[] }).params).toEqual([]);
    expect(String((failed as Error & { cause: unknown }).cause)).toContain("no_such_table");
  });

  it("still answers when nothing fails", async () => {
    const { rows } = (await db.execute(sql`select ${SESSION_TOKEN} as token`)) as unknown as { rows: { token: string }[] };
    expect(rows[0].token).toBe(SESSION_TOKEN);
  });
});
