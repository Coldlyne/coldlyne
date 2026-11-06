import { beforeAll, describe, expect, it } from "vitest";
import { connectionsOf } from "@/application/connections";
import { createList, listsOf } from "@/application/prospects";
import type { Services } from "@/application/services";
import { saveSettings, settingsOf } from "@/application/workspace-settings";
import { activeWorkspace, mayStartWorkspace, startWorkspace, workspaceNamed, workspacesOf, type MemberWorkspace } from "@/application/workspaces";
import { safeNext } from "@/domain/safe-next";
import { listInFrench } from "@/domain/words";
import type { Database } from "@/infrastructure/db/client";
import type { Env } from "@/infrastructure/env";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { fakeFetch } from "./support/fetch";

const settings = { COLDLYNE_ADMINS: "founder@example.com, Other@Example.com", BETTER_AUTH_URL: "https://coldlyne.test", COLDLYNE_SECRETS_KEY: Buffer.alloc(32, 1).toString("base64") } as Env;

const ACME: MemberWorkspace = { id: "11111111-1111-4111-8111-111111111111", name: "Acme", role: "owner", group: "Acme" };
const NORTHWIND: MemberWorkspace = { id: "22222222-2222-4222-8222-222222222222", name: "Northwind", role: "member", group: "Northwind" };

let db: Database;
let services: Services;
beforeAll(async () => {
  db = await createTestDatabase();
  services = { db, settings, fetch: fakeFetch([]).fetch, now: () => new Date("2026-11-05T09:00:00Z") };
});

describe("which workspace a browser is in", () => {
  it("is the one it asked for, among the member's", () => {
    expect(activeWorkspace([ACME, NORTHWIND], NORTHWIND.id)).toBe(NORTHWIND);
  });

  it.each([undefined, "", "not-a-uuid", "33333333-3333-4333-8333-333333333333"])("falls back to their first when it asks for %s", (wanted) => {
    expect(activeWorkspace([ACME, NORTHWIND], wanted)).toBe(ACME);
  });

  it("is none for someone with none, whatever it asks for", () => {
    expect(activeWorkspace([], ACME.id)).toBeUndefined();
  });
});

describe("which workspace an assistant's call names", () => {
  it("is found by id or by exact name", () => {
    expect(workspaceNamed([ACME, NORTHWIND], NORTHWIND.id)).toBe(NORTHWIND);
    expect(workspaceNamed([ACME, NORTHWIND], "Northwind")).toBe(NORTHWIND);
  });

  it.each(["northwind", " Northwind", "Kled", "", "33333333-3333-4333-8333-333333333333"])("isn't %j, even close to one of theirs", (named) => {
    expect(workspaceNamed([ACME, NORTHWIND], named)).toBeNull();
  });

  it("is none when several are theirs and the call says nothing: nothing is ever assumed", () => {
    expect(workspaceNamed([ACME, NORTHWIND], undefined)).toBeNull();
  });

  it("is their only one when the call says nothing, but not when it names another", () => {
    expect(workspaceNamed([ACME], undefined)).toBe(ACME);
    expect(workspaceNamed([ACME], "Acme")).toBe(ACME);
    expect(workspaceNamed([ACME], "Northwind")).toBeNull();
  });

  it("is none when a name could be two of theirs", () => {
    const twin = { ...NORTHWIND, name: "Acme" };
    expect(workspaceNamed([ACME, twin], "Acme")).toBeNull();
    expect(workspaceNamed([ACME, twin], twin.id)).toBe(twin);
  });
});

describe("who may start a workspace", () => {
  it("is an address on the instance's list, however it's written", () => {
    expect(mayStartWorkspace("founder@example.com", settings)).toBe(true);
    expect(mayStartWorkspace(" FOUNDER@example.com", settings)).toBe(true);
    expect(mayStartWorkspace("other@example.com", settings)).toBe(true);
    expect(mayStartWorkspace("invited@example.com", settings)).toBe(false);
  });

  it("lets an admin start their first and another, the first one joined staying first", async () => {
    const { userId } = await createTestWorkspace(db, "First");
    const second = await startWorkspace(db, settings, { userId, email: "founder@example.com" }, "  Second  ");
    expect(second).toEqual(expect.any(String));
    expect(await workspacesOf(db, userId)).toEqual([expect.objectContaining({ name: "First", role: "owner" }), { id: second, name: "Second", role: "owner", group: "Second" }]);
  });

  it("refuses anyone else, even an owner of a workspace they were given, and adds nothing", async () => {
    const { userId } = await createTestWorkspace(db, "Theirs");
    expect(await startWorkspace(db, settings, { userId, email: "invited@example.com" }, "Another")).toBeNull();
    expect(await workspacesOf(db, userId)).toHaveLength(1);
  });

  it("wants a name", async () => {
    const { userId } = await createTestWorkspace(db);
    expect(await startWorkspace(db, settings, { userId, email: "founder@example.com" }, "   ")).toBeNull();
  });

  it("starts empty: nothing comes from the admin's other workspaces, no brief, no list, no mailbox", async () => {
    const { workspaceId: first, userId } = await createTestWorkspace(db, "First");
    await saveSettings(db, first, { brief: { target: "Holdings" }, senderName: "First SAS", senderAddress: "1 rue de la Paix, 75002 Paris" });
    await createList(db, first, "First's list");
    const second = (await startWorkspace(db, settings, { userId, email: "founder@example.com" }, "Second")) as string;
    expect(await settingsOf(db, second)).toMatchObject({ brief: {}, senderName: null, senderAddress: null });
    expect(await listsOf(db, second)).toEqual([]);
    expect(await connectionsOf(services, second)).toEqual([]);
  });
});

describe("where to go next", () => {
  it.each(["/", "/consent?client_id=a&scope=openid+profile", "/join/abc", "/connections/gmail"])("may be %s, a page of this app", (next) => {
    expect(safeNext(next)).toBe(next);
  });

  it.each(["https://evil.example", "//evil.example", "/\\evil.example", "/\t/evil.example", "/\n/evil.example", "evil", undefined, null, 1, ["/x"]])("is home rather than %j", (next) => {
    expect(safeNext(next)).toBe("/");
  });
});

describe("names in a sentence", () => {
  it.each([
    [[], ""],
    [["A"], "A"],
    [["A", "B"], "A et B"],
    [["A", "B", "C"], "A, B et C"],
  ])("says %j as %j", (names, said) => {
    expect(listInFrench(names)).toBe(said);
  });
});
