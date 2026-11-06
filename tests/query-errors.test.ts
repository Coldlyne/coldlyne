import { inspect } from "node:util";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { beforeAll, describe, expect, it } from "vitest";
import { connect, type Database } from "@/infrastructure/db/client";
import { causeWithoutValues, keepParametersOutOfQueryErrors } from "@/infrastructure/db/query-errors";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { createTestDatabase, createTestWorkspace } from "./support/database";

const SESSION_TOKEN = "a-session-token-nobody-should-log";
const EMAIL = "nobody-should-log-this@example.test";
const NOTHING_LISTENS_HERE = "postgres://nobody:nobody@127.0.0.1:1/nothing";

type Failure = Error & { query: string; params: unknown[]; cause: Error & Record<string, unknown> };

const failureOf = (work: Promise<unknown>) =>
  work.then(
    () => {
      throw new Error("This query should have failed.");
    },
    (error: Failure) => error,
  );

/** Every way a logger or an answer could print an error, what's hidden included. */
function everyPrintingOf(error: Error): string[] {
  return [
    String(error),
    String(error.stack),
    inspect(error),
    inspect(error, { depth: null, showHidden: true }),
    String(JSON.stringify(error)),
    JSON.stringify(error, Object.getOwnPropertyNames(error)),
  ];
}

function expectNowhere(error: Failure, value: string): void {
  for (const printing of [...everyPrintingOf(error), ...everyPrintingOf(error.cause)]) expect(printing).not.toContain(value);
}

describe("a query that fails", () => {
  let db: Database;

  beforeAll(async () => {
    keepParametersOutOfQueryErrors();
    db = await createTestDatabase();
    await db.execute(sql`create table query_probe (id int primary key, email text unique, token text not null, owner uuid)`);
    await db.execute(sql`insert into query_probe values (1, ${EMAIL}, 'a token', null)`);
  });

  // Also the guard: if an upgrade stops Drizzle calling the method this wraps, the token comes back here.
  it("says its statement and why, and never its parameters", async () => {
    const failed = await failureOf(db.execute(sql`select * from no_such_table where token = ${SESSION_TOKEN}`));
    expect(failed).toBeInstanceOf(Error);
    expect(failed.message).toContain("no_such_table");
    expect(failed.params).toEqual([]);
    expect(String(failed.cause)).toContain("no_such_table");
    expectNowhere(failed, SESSION_TOKEN);
  });

  it("says which constraint a duplicate broke, and not the value", async () => {
    const failed = await failureOf(db.execute(sql`insert into query_probe values (2, ${EMAIL}, 'a token', null)`));
    expect(failed.query).toContain("insert into query_probe");
    expect(failed.cause).toMatchObject({ code: "23505", severity: "ERROR", constraint_name: "query_probe_email_key", table_name: "query_probe", routine: "_bt_check_unique" });
    expect(failed.cause.message).toContain("duplicate key");
    expect(failed.cause.detail).toBeUndefined();
    expectNowhere(failed, EMAIL);
  });

  it("says which column a missing value is for, and not the rest of the row", async () => {
    const failed = await failureOf(db.execute(sql`insert into query_probe values (3, ${`another-${EMAIL}`}, null, null)`));
    expect(failed.cause).toMatchObject({ code: "23502", severity: "ERROR", column_name: "token", table_name: "query_probe", routine: expect.any(String) });
    expect(failed.cause.message).toContain("not-null");
    expect(failed.cause.detail).toBeUndefined();
    expectNowhere(failed, EMAIL);
  });

  it("says a value has the wrong type, and not the value", async () => {
    const failed = await failureOf(db.execute(sql`select * from query_probe where owner = ${SESSION_TOKEN}`));
    expect(failed.query).toContain("query_probe");
    expect(failed.cause).toMatchObject({ code: "22P02", severity: "ERROR", routine: "string_to_uuid" });
    expect(failed.cause.message).toContain("22P02");
    expectNowhere(failed, SESSION_TOKEN);
  });

  it("says nothing more inside a workspace's transaction", async () => {
    const { workspaceId } = await createTestWorkspace(db);
    const failed = await failureOf(withWorkspace(db, workspaceId, (tx) => tx.execute(sql`select ${SESSION_TOKEN}::uuid`)));
    expect(failed.cause).toMatchObject({ code: "22P02" });
    expectNowhere(failed, SESSION_TOKEN);
  });

  // The guard on the driver production runs: PGlite passing proves nothing about it.
  it("says nothing either through postgres.js, keeping why it couldn't connect", async () => {
    const failed = await failureOf(connect(NOTHING_LISTENS_HERE).execute(sql`select ${SESSION_TOKEN}`));
    expect(failed.params).toEqual([]);
    expect(failed.cause).toMatchObject({ code: "ECONNREFUSED" });
    expect(failed.cause.message).toContain("ECONNREFUSED");
    expectNowhere(failed, SESSION_TOKEN);
  });

  it("still answers when nothing fails", async () => {
    const { rows } = (await db.execute(sql`select ${SESSION_TOKEN} as token`)) as unknown as { rows: { token: string }[] };
    expect(rows[0].token).toBe(SESSION_TOKEN);
  });
});

describe("the cause of a failed query", () => {
  const PostgresError = postgres.PostgresError as unknown as new (fields: object) => Error;

  /** The error postgres.js makes, with the parameters it hides on it. */
  function fromPostgresJs(fields: object): Error {
    const hidden = { value: [SESSION_TOKEN] };
    return Object.defineProperties(new PostgresError({ severity: "ERROR", detail: SESSION_TOKEN, hint: SESSION_TOKEN, where: `unnamed portal parameter $1 = '${SESSION_TOKEN}'`, internal_query: SESSION_TOKEN, ...fields }), { parameters: hidden, args: hidden });
  }

  it("keeps postgres.js's safe fields and none that can repeat a value", () => {
    const cause = causeWithoutValues(fromPostgresJs({ message: 'duplicate key value violates unique constraint "a_key"', code: "23505", constraint_name: "a_key", table_name: "a_table", column_name: "a_column", routine: "_bt_check_unique" })) as Error;
    expect({ ...cause }).toEqual({ code: "23505", severity: "ERROR", constraint_name: "a_key", table_name: "a_table", column_name: "a_column", routine: "_bt_check_unique" });
    expect(cause.message).toContain("duplicate key");
    for (const printing of everyPrintingOf(cause)) expect(printing).not.toContain(SESSION_TOKEN);
  });

  it.each([
    ["a bad type", "22P02", `invalid input syntax for type uuid: "${SESSION_TOKEN}"`],
    ["a number out of range", "22003", `value "${SESSION_TOKEN}" is out of range for type integer`],
    ["a function's own words", "P0001", `No such member: ${SESSION_TOKEN}`],
    ["a class nobody has looked at", "ZZ999", `Something about ${SESSION_TOKEN}`],
  ])("keeps the code and not the words of %s", (_name, code, message) => {
    const cause = causeWithoutValues(fromPostgresJs({ message, code })) as Error;
    expect(cause.message).toContain(code);
    for (const printing of everyPrintingOf(cause)) expect(printing).not.toContain(SESSION_TOKEN);
  });

  it("leaves out what an error without a known code says", () => {
    const cause = causeWithoutValues(new TypeError(`Can't send ${SESSION_TOKEN}`)) as Error;
    expect(cause.message).toContain("no code");
    expect(cause.message).not.toContain(SESSION_TOKEN);
  });

  it("is nothing when there was none", () => {
    expect(causeWithoutValues(undefined)).toBeUndefined();
    expect(causeWithoutValues(null)).toBeUndefined();
  });
});
