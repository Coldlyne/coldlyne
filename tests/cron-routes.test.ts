import { eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as sync } from "@/app/api/cron/sync/route";
import { GET as watch } from "@/app/api/cron/watch/route";
import { connectWithFields } from "@/application/connections";
import { createList } from "@/application/prospects";
import type { Services } from "@/application/services";
import { createWatchlist } from "@/application/watchlists";
import type { Database } from "@/infrastructure/db/client";
import { connection } from "@/infrastructure/db/schema/connections";
import { watchlist } from "@/infrastructure/db/schema/sequences";
import { withWorkspace } from "@/infrastructure/db/tenant";
import type { Env } from "@/infrastructure/env";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { fakeFetch } from "./support/fetch";

const shared = vi.hoisted(() => ({ services: undefined as unknown }));
const reads = vi.hoisted(() => [] as string[]);
vi.mock("next/cache", () => ({ revalidateTag: vi.fn(), cacheLife: () => {}, cacheTag: () => {} }));
vi.mock("@/infrastructure/services", () => ({ appServices: () => shared.services }));
vi.mock("@/app/api/cron/scheduled-work", () => ({ cronRefusal: () => null, scheduledWork: async () => ({ sending: true, reading: true, watching: true }) }));
vi.mock("@/infrastructure/connectors", () => ({
  adapterOf: () => (context: { fields: Record<string, string> }) => ({
    check: async () => ({ ok: true, detail: "ok", label: "Compte" }),
    signalsSince: async () => {
      reads.push(context.fields.address);
      return [];
    },
  }),
}));

const settings = { BETTER_AUTH_URL: "https://coldlyne.test", COLDLYNE_SECRETS_KEY: Buffer.alloc(32, 1).toString("base64") } as Env;
const SMTP = { smtpHost: "smtp.acme.fr", smtpPort: "587", imapHost: "imap.acme.fr", imapPort: "993", password: "secret" };
const NOW = new Date("2026-11-04T09:00:00Z");
const ask = () => new Request("https://coldlyne.test/api/cron");

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
beforeEach(async () => {
  shared.services = { db, settings, fetch: fakeFetch([]).fetch, now: () => NOW } satisfies Services;
  reads.length = 0;
  await db.delete(connection);
  await db.delete(watchlist);
});

async function mailboxOf(address: string) {
  const { workspaceId, userId } = await createTestWorkspace(db);
  const made = await connectWithFields(shared.services as Services, workspaceId, userId, "smtp", { ...SMTP, address });
  if (!made.ok) throw new Error(made.error);
  return { workspaceId, connectionId: made.connection.id };
}

describe("the hourly read", () => {
  it("goes on to the next workspace when one holds a connection it can't open", async () => {
    const broken = await mailboxOf("ada@broken.fr");
    await mailboxOf("bea@fine.fr");
    await withWorkspace(db, broken.workspaceId, (tx) => tx.update(connection).set({ sealedCredentials: "unreadable" }).where(eq(connection.id, broken.connectionId)));
    const response = await sync(ask());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ workspaces: 2, failed: 1 });
    expect(reads).toEqual(["bea@fine.fr"]);
  });
});

describe("the daily watch", () => {
  async function watchIn() {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const listId = await createList(db, workspaceId, "Veille");
    return { workspaceId, id: await createWatchlist(db, workspaceId, userId, { name: "Veille", listId, query: { families: ["creation"] } }) };
  }
  const lastErrorOf = async (one: { workspaceId: string; id: string }) => (await withWorkspace(db, one.workspaceId, (tx) => tx.select().from(watchlist).where(eq(watchlist.id, one.id))))[0].lastError;

  it("goes on to the next one when one can't even record its failure", async () => {
    const broken = await watchIn();
    const fine = await watchIn();
    // The public service is down, so each run writes down why; on this row, writing it fails too.
    await db.execute(sql.raw(`alter table watchlist add constraint fail_for_a_test check (id <> '${broken.id}' or last_error is null) not valid`));
    const response = await watch(ask()).finally(() => db.execute(sql`alter table watchlist drop constraint fail_for_a_test`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ checked: 2, failed: 1 });
    expect(await lastErrorOf(fine)).toBeTruthy();
    expect(await lastErrorOf(broken)).toBeNull();
  });
});
