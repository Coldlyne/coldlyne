import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connectWithFields, disconnect } from "@/application/connections";
import { createList } from "@/application/prospects";
import { whatIsScheduled } from "@/application/scheduled-work";
import type { Services } from "@/application/services";
import { createWatchlist, deleteWatchlist } from "@/application/watchlists";
import type { Database } from "@/infrastructure/db/client";
import { connection } from "@/infrastructure/db/schema/connections";
import { watchlist } from "@/infrastructure/db/schema/sequences";
import type { Env } from "@/infrastructure/env";
import { SCHEDULED_WORK_TAG, scheduledWorkChanged } from "@/infrastructure/scheduling/scheduled-work";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { fakeFetch } from "./support/fetch";

const revalidateTag = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidateTag }));
vi.mock("@/infrastructure/connectors", () => ({
  adapterOf: () => () => ({ check: async () => ({ ok: true, detail: "ok", label: "compte" }) }),
}));

const settings = { BETTER_AUTH_URL: "https://coldlyne.test", COLDLYNE_SECRETS_KEY: Buffer.alloc(32, 1).toString("base64") } as Env;
const SMTP = { smtpHost: "smtp.acme.fr", smtpPort: "587", imapHost: "imap.acme.fr", imapPort: "993", password: "secret", address: "ada@acme.fr" };

let db: Database;
let services: Services;
beforeAll(async () => {
  db = await createTestDatabase();
  services = { db, settings, fetch: fakeFetch([]).fetch, now: () => new Date("2026-11-04T09:00:00Z") };
});
beforeEach(async () => {
  revalidateTag.mockReset();
  await db.delete(watchlist);
  await db.delete(connection);
});

const connect = async (workspaceId: string, userId: string, kind: string, fields: Record<string, string>) => {
  const made = await connectWithFields(services, workspaceId, userId, kind, fields);
  if (!made.ok) throw new Error(made.error);
  return made.connection.id;
};

describe("what the scheduled jobs have to do", () => {
  it("is nothing on an empty instance", async () => {
    expect(await whatIsScheduled(db)).toMatchObject({ reading: false, watching: false });
  });

  it("is reading once a mailbox is connected, even a failing one, which still has to recover", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    await connect(workspaceId, userId, "smtp", SMTP);
    expect((await whatIsScheduled(db)).reading).toBe(true);
    await db.update(connection).set({ status: "failing" });
    expect((await whatIsScheduled(db)).reading).toBe(true);
  });

  it("isn't reading for a service with nothing to read, like a company lookup", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    await connect(workspaceId, userId, "sirene", { apiKey: "clé" });
    expect((await whatIsScheduled(db)).reading).toBe(false);
  });

  it("is watching while a watch exists", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const listId = await createList(db, workspaceId, "Veille");
    const id = await createWatchlist(db, workspaceId, userId, { name: "Holdings", query: {}, listId });
    expect((await whatIsScheduled(db)).watching).toBe(true);
    await deleteWatchlist(db, workspaceId, id);
    expect((await whatIsScheduled(db)).watching).toBe(false);
  });
});

describe("what's known about it", () => {
  const cleared = () => revalidateTag.mock.calls.filter(([tag]) => tag === SCHEDULED_WORK_TAG).length;

  it("is cleared at once, so a run started right after doesn't read the old answer", () => {
    scheduledWorkChanged();
    expect(revalidateTag).toHaveBeenCalledWith(SCHEDULED_WORK_TAG, { expire: 0 });
  });

  it("doesn't stop anything outside a request, where nothing is cached to clear", () => {
    revalidateTag.mockImplementation(() => {
      throw new Error("Invariant: static generation store missing");
    });
    expect(() => scheduledWorkChanged()).not.toThrow();
  });

  it("is cleared by connecting a service and by disconnecting it", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const id = await connect(workspaceId, userId, "smtp", SMTP);
    expect(cleared()).toBe(1);
    await disconnect(services, workspaceId, id);
    expect(cleared()).toBe(2);
  });

  it("is cleared by creating a watch and by deleting it", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const listId = await createList(db, workspaceId, "Veille");
    const id = await createWatchlist(db, workspaceId, userId, { name: "Holdings", query: {}, listId });
    expect(cleared()).toBe(1);
    await deleteWatchlist(db, workspaceId, id);
    expect(cleared()).toBe(2);
  });
});
