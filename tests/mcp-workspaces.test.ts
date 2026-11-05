import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { answerInFull } from "@/app/mcp/answer-in-full";
import { POST } from "@/app/mcp/route";
import { createList } from "@/application/prospects";
import type { Services } from "@/application/services";
import { removeMember } from "@/application/team";
import { startWorkspace } from "@/application/workspaces";
import type { Database } from "@/infrastructure/db/client";
import { user } from "@/infrastructure/db/schema/auth";
import { member } from "@/infrastructure/db/schema/tenancy";
import type { Env } from "@/infrastructure/env";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { fakeFetch } from "./support/fetch";

const token = vi.hoisted(() => ({ userId: "" as string | null }));
const shared = vi.hoisted(() => ({ services: undefined as unknown, settings: { BETTER_AUTH_URL: "https://coldlyne.test" } }));
vi.mock("server-only", () => ({}));
vi.mock("@/infrastructure/auth/server", () => ({
  memberOfToken: async () => {
    if (!token.userId) throw new Error("No token");
    return { userId: token.userId, clientId: "assistant" };
  },
}));
vi.mock("@/infrastructure/db/client", async (original) => ({ ...(await original<typeof import("@/infrastructure/db/client")>()), db: () => (shared.services as Services).db }));
vi.mock("@/infrastructure/env", async (original) => ({ ...(await original<typeof import("@/infrastructure/env")>()), env: () => shared.settings }));
vi.mock("@/infrastructure/services", () => ({ appServices: () => shared.services }));
vi.mock("@/app/mcp/answer-in-full", async (original) => {
  const real = await original<typeof import("@/app/mcp/answer-in-full")>();
  return { answerInFull: vi.fn(real.answerInFull) };
});

const settings = { COLDLYNE_ADMINS: "founder@example.com", BETTER_AUTH_URL: "https://coldlyne.test", COLDLYNE_SECRETS_KEY: Buffer.alloc(32, 1).toString("base64") } as Env;

let db: Database;
let services: Services;
beforeAll(async () => {
  db = await createTestDatabase();
  services = { db, settings, fetch: fakeFetch([]).fetch, now: () => new Date("2026-11-05T09:00:00Z") };
  shared.services = services;
});
beforeEach(() => {
  token.userId = null;
});

/** Speaks to /mcp over HTTP, as an assistant does: the real route, with only the token's signature assumed. */
async function send(message: unknown) {
  const response = await POST(
    new Request("https://coldlyne.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer token", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify(message),
    }),
  );
  const text = await response.text();
  if (text.startsWith("{")) return { status: response.status, body: JSON.parse(text), text };
  const replies = text.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
  return { status: response.status, body: Array.isArray(message) ? replies : (replies[0] ?? null), text };
}

const rpc = async (method: string, params: Record<string, unknown> = {}) => (await send({ jsonrpc: "2.0", id: 1, method, params })).body.result;
const tool = (name: string, args: Record<string, unknown> = {}) => rpc("tools/call", { name, arguments: args });
const listNames = (result: { structuredContent: { lists: { name: string }[] } }) => result.structuredContent.lists.map(({ name }) => name);

/** A member with two workspaces, each with its own list, and a stranger's with its own. */
async function memberOfTwo() {
  const { workspaceId: acme, userId } = await createTestWorkspace(db, "Acme");
  const northwind = (await startWorkspace(db, settings, { userId, email: "founder@example.com" }, "Northwind")) as string;
  const stranger = await createTestWorkspace(db, "Secret Corp");
  await createList(db, acme, "Acme's list");
  await createList(db, northwind, "Northwind's list");
  await createList(db, stranger.workspaceId, "Secret list");
  token.userId = userId;
  return { acme, northwind, userId, stranger: stranger.workspaceId };
}

const refusedWithNames = (result: { isError?: boolean; content: { text: string }[] }) => {
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('"Acme"');
  expect(result.content[0].text).toContain('"Northwind"');
};

describe("an assistant, for a member with several workspaces", () => {
  it("answers the protocol's own methods without asking which workspace", async () => {
    await memberOfTwo();
    const started = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(started.serverInfo.name).toBe("coldlyne");
    expect(started.instructions).toContain("confirm with the member which workspace");
    expect((await send({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    expect(await rpc("ping")).toEqual({});
  });

  it("offers an optional workspace argument on every tool but list_workspaces, saying what it's for", async () => {
    await memberOfTwo();
    const { tools } = await rpc("tools/list");
    for (const { name, inputSchema } of tools) {
      if (name === "list_workspaces") {
        expect(inputSchema.properties ?? {}).not.toHaveProperty("workspace");
        continue;
      }
      expect(inputSchema.properties.workspace, name).toMatchObject({ type: "string", description: expect.stringContaining("exact name") });
      expect(inputSchema.required ?? []).not.toContain("workspace");
    }
  });

  it("lists their workspaces with their role, read-only", async () => {
    const { acme, northwind } = await memberOfTwo();
    const { tools } = await rpc("tools/list");
    expect(tools.find(({ name }: { name: string }) => name === "list_workspaces").annotations.readOnlyHint).toBe(true);
    const { structuredContent } = await tool("list_workspaces");
    expect(structuredContent.workspaces).toEqual([
      { id: acme, name: "Acme", role: "owner" },
      { id: northwind, name: "Northwind", role: "owner" },
    ]);
  });

  it("refuses a call that names no workspace, listing theirs so the assistant asks", async () => {
    await memberOfTwo();
    refusedWithNames(await tool("list_lists"));
  });

  it("works in the workspace named, by name or by id, and sees only that one's", async () => {
    const { acme, northwind } = await memberOfTwo();
    expect(listNames(await tool("list_lists", { workspace: "Acme" }))).toEqual(["Acme's list"]);
    expect(listNames(await tool("list_lists", { workspace: "Northwind" }))).toEqual(["Northwind's list"]);
    expect(listNames(await tool("list_lists", { workspace: acme }))).toEqual(["Acme's list"]);
    expect(listNames(await tool("list_lists", { workspace: northwind }))).toEqual(["Northwind's list"]);
  });

  it("writes in the workspace named, and nowhere else", async () => {
    const { acme, northwind } = await memberOfTwo();
    await tool("create_list", { workspace: "Northwind", name: "Written by the assistant" });
    expect(listNames(await tool("list_lists", { workspace: northwind }))).toContain("Written by the assistant");
    expect(listNames(await tool("list_lists", { workspace: acme }))).not.toContain("Written by the assistant");
  });

  it("gives the same refusal for a workspace that doesn't exist and one that isn't theirs, by name or id", async () => {
    const { stranger } = await memberOfTwo();
    const without = await tool("list_lists");
    for (const named of ["Secret Corp", stranger, "Nobody's", "acme", "33333333-3333-4333-8333-333333333333"]) {
      const refused = await tool("list_lists", { workspace: named });
      expect(refused).toEqual(without);
      expect(JSON.stringify(refused)).not.toContain("Secret");
    }
  });

  it("can't write into a workspace that isn't theirs", async () => {
    const { stranger } = await memberOfTwo();
    refusedWithNames(await tool("create_list", { workspace: stranger, name: "Planted" }));
    token.userId = (await db.select({ userId: member.userId }).from(member).where(eq(member.workspaceId, stranger)))[0].userId;
    expect(listNames(await tool("list_lists"))).toEqual(["Secret list"]);
  });

  it("serves each call of a batch in its own workspace", async () => {
    await memberOfTwo();
    const call = (id: number, workspace?: string) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "list_lists", arguments: workspace ? { workspace } : {} } });
    const { body } = await send([call(1, "Acme"), call(2, "Northwind"), call(3)]);
    const byId = Object.fromEntries(body.map((reply: { id: number; result: unknown }) => [reply.id, reply.result]));
    expect(listNames(byId[1])).toEqual(["Acme's list"]);
    expect(listNames(byId[2])).toEqual(["Northwind's list"]);
    refusedWithNames(byId[3]);
  });

  it("still validates a tool's own arguments", async () => {
    await memberOfTwo();
    const refused = await tool("create_list", { workspace: "Acme" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("Invalid arguments");
  });

  it("links a page through the workspace it was asked about, since the screens use the browser's", async () => {
    const { northwind } = await memberOfTwo();
    const { structuredContent } = await tool("connect_service", { workspace: "Northwind", kind: "brevo_sms" });
    expect(structuredContent.url).toBe(`https://coldlyne.test/workspace/${northwind}?next=%2Fconnections%2Fbrevo_sms`);
    const brief = await tool("read_brief", { workspace: "Northwind" });
    expect(brief.structuredContent.settingsPage).toBe(`https://coldlyne.test/workspace/${northwind}?next=%2Fsettings`);
  });

  it("offers nothing that invites, removes or changes members", async () => {
    await memberOfTwo();
    const { tools } = await rpc("tools/list");
    for (const { name } of tools) expect(name).not.toMatch(/invit|member|team|role/i);
    expect(tools.map(({ name }: { name: string }) => name).filter((name: string) => /workspace/.test(name))).toEqual(["list_workspaces"]);
  });

  it("forgets a workspace at once when they're taken out of it, even on the same token", async () => {
    const { acme, northwind, userId } = await memberOfTwo();
    expect(listNames(await tool("list_lists", { workspace: "Northwind" }))).toEqual(["Northwind's list"]);
    await db.delete(member).where(and(eq(member.workspaceId, northwind), eq(member.userId, userId)));
    const refused = await tool("list_lists", { workspace: "Northwind" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('"Acme"');
    expect(refused.content[0].text).not.toContain("Northwind");
    expect((await tool("list_workspaces")).structuredContent.workspaces).toEqual([{ id: acme, name: "Acme", role: "owner" }]);
  });
});

describe("an assistant, for a member with one workspace", () => {
  async function memberOfOne() {
    const { workspaceId, userId } = await createTestWorkspace(db, "Solo");
    await createList(db, workspaceId, "Solo's list");
    token.userId = userId;
    return { workspaceId, userId };
  }

  it("sees no workspace argument anywhere, and no word about several", async () => {
    await memberOfOne();
    const { tools } = await rpc("tools/list");
    expect(tools.length).toBeGreaterThan(50);
    for (const { name, inputSchema } of tools) expect(inputSchema.properties ?? {}, name).not.toHaveProperty("workspace");
    expect(JSON.stringify(tools)).not.toContain("exact name");
    const started = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(started.instructions).not.toContain("several companies");
  });

  it("works as before, with no argument to give", async () => {
    await memberOfOne();
    expect(listNames(await tool("list_lists"))).toEqual(["Solo's list"]);
    await tool("create_list", { name: "Another" });
    expect(listNames(await tool("list_lists"))).toEqual(expect.arrayContaining(["Solo's list", "Another"]));
  });

  it("links a page as before", async () => {
    await memberOfOne();
    const { structuredContent } = await tool("connect_service", { kind: "brevo_sms" });
    expect(structuredContent.url).toBe("https://coldlyne.test/connections/brevo_sms");
  });

  it("still lists their workspace", async () => {
    const { workspaceId } = await memberOfOne();
    expect((await tool("list_workspaces")).structuredContent.workspaces).toEqual([{ id: workspaceId, name: "Solo", role: "owner" }]);
  });

  it("accepts its own workspace named, but refuses another rather than quietly using theirs", async () => {
    const { workspaceId } = await memberOfOne();
    expect(listNames(await tool("list_lists", { workspace: "Solo" }))).toEqual(["Solo's list"]);
    expect(listNames(await tool("list_lists", { workspace: workspaceId }))).toEqual(["Solo's list"]);
    const refused = await tool("create_list", { workspace: "The one they left", name: "Wrong company" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('"Solo"');
    expect(listNames(await tool("list_lists"))).not.toContain("Wrong company");
  });
});

describe("/mcp at its door", () => {
  it("answers 401 without a token, pointing at how to sign in", async () => {
    const { status, body } = await send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(status).toBe(401);
    expect(body.error).toBe("unauthorized");
  });

  it("keeps its 403 for someone with no workspace, even for list_workspaces", async () => {
    const id = crypto.randomUUID();
    await db.insert(user).values({ id, name: "Bea", email: `${id}@example.test` });
    token.userId = id;
    const { status, body } = await send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_workspaces", arguments: {} } });
    expect(status).toBe(403);
    expect(body).toMatchObject({ error: "no_workspace", error_description: expect.stringContaining("https://coldlyne.test/welcome") });
  });

  it("gives that 403 to someone removed from their only workspace, on their next call", async () => {
    const { workspaceId, userId: ownerId } = await createTestWorkspace(db, "Team");
    const id = crypto.randomUUID();
    await db.insert(user).values({ id, name: "Bea", email: `${id}@example.test` });
    await db.insert(member).values({ workspaceId, userId: id, role: "member" });
    token.userId = id;
    expect((await tool("list_lists")).structuredContent.lists).toEqual([]);
    await removeMember(db, workspaceId, ownerId, id);
    expect((await send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_lists", arguments: {} } })).status).toBe(403);
  });

  it("keeps reading a tool's answer to its end before returning, refusals included", async () => {
    await memberOfTwo();
    vi.mocked(answerInFull).mockClear();
    const { text } = await send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_lists", arguments: { workspace: "Acme" } } });
    expect(text).toContain("Acme's list");
    await tool("list_lists");
    expect(answerInFull).toHaveBeenCalledTimes(2);
  });
});
