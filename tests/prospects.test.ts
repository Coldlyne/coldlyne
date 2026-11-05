import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { addFromRegistry, createList, prospectsOf } from "@/application/prospects";
import { fromRegistry } from "@/domain/registry";
import type { Database } from "@/infrastructure/db/client";
import { company } from "@/infrastructure/db/schema/prospects";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { holding } from "./support/registry";

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
});

describe("prospects from the registry", () => {
  it("puts each company's directors who are people on the list, and leaves out companies that refused commercial use or closed", async () => {
    const { workspaceId } = await createTestWorkspace(db);
    const list = await createList(db, workspaceId, "Holdings, Rhône");

    const result = await addFromRegistry(db, workspaceId, list, [holding("900000001"), holding("900000002", { opposition_diffusion_commerciale: true }), holding("900000003", { etat_administratif: "C" })].map(fromRegistry));

    expect(result).toEqual({
      added: 1,
      skipped: [
        { siren: "900000002", name: "ACME HOLDING", why: "refused commercial use of its data" },
        { siren: "900000003", name: "ACME HOLDING", why: "closed" },
      ],
    });
    expect(await prospectsOf(db, workspaceId, list)).toMatchObject([{ firstName: "Jeanne", lastName: "Dupont-Martin", role: "Président de SAS", company: "ACME HOLDING", city: "LYON", state: "new" }]);
  });

  it("reuses a company and a person already known, and adds no one twice", async () => {
    const { workspaceId } = await createTestWorkspace(db);
    const [first, second] = [await createList(db, workspaceId, "A"), await createList(db, workspaceId, "B")];

    await addFromRegistry(db, workspaceId, first, [fromRegistry(holding())]);
    const again = await addFromRegistry(db, workspaceId, first, [fromRegistry(holding())]);
    await addFromRegistry(db, workspaceId, second, [fromRegistry(holding())]);

    expect(again.added).toBe(0);
    expect((await prospectsOf(db, workspaceId, second)).length).toBe(1);
    expect(await withWorkspace(db, workspaceId, (tx) => tx.select().from(company))).toHaveLength(1);
  });
});

describe("workspaces", () => {
  it("never see each other's prospects, even when a query forgets to filter", async () => {
    const [mine, theirs] = [await createTestWorkspace(db, "Northwind"), await createTestWorkspace(db, "Other")];
    await addFromRegistry(db, theirs.workspaceId, await createList(db, theirs.workspaceId, "Theirs"), [fromRegistry(holding())]);

    const seen = await withWorkspace(db, mine.workspaceId, (tx) => tx.execute(sql`select count(*)::int as count from company`));

    expect((seen as unknown as { rows: { count: number }[] }).rows[0].count).toBe(0);
  });
});
