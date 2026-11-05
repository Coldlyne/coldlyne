import { createMcpHandler } from "@modelcontextprotocol/server";
import { beforeAll, describe, expect, it } from "vitest";
import { coldlyneServer } from "@/app/api/mcp/server";
import { addFromRegistry, createList } from "@/application/prospects";
import type { Services } from "@/application/services";
import { saveSettings, settingsOf } from "@/application/workspace-settings";
import { fromRegistry } from "@/domain/registry";
import type { Database } from "@/infrastructure/db/client";
import type { Env } from "@/infrastructure/env";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { fakeFetch } from "./support/fetch";
import { holding } from "./support/registry";

const settings = { BETTER_AUTH_URL: "https://coldlyne.test", COLDLYNE_SECRETS_KEY: Buffer.alloc(32, 1).toString("base64") } as Env;
const registry = { match: "GET https://recherche-entreprises.api.gouv.fr/search", json: { results: [holding("900000001")], total_results: 1, page: 1, total_pages: 1 } };

let db: Database;
let services: Services;
beforeAll(async () => {
  db = await createTestDatabase();
  services = { db, settings, fetch: fakeFetch([registry]).fetch, now: () => new Date("2026-11-04T09:00:00Z") };
});

/** Speaks to the MCP server over HTTP, as an assistant does (one JSON-RPC exchange per request). */
function clientFor(workspaceId: string, userId: string) {
  const handler = createMcpHandler(() => coldlyneServer({ services, userId, workspaces: [{ id: workspaceId, name: "Northwind", role: "owner" }] }));
  return async function call(method: string, params: Record<string, unknown> = {}) {
    const response = await handler.fetch(
      new Request("https://coldlyne.test/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
    const text = await response.text();
    const json = text.startsWith("{") ? text : (text.split("\n").find((line) => line.startsWith("data: ")) ?? "").slice(6);
    return JSON.parse(json).result;
  };
}

const callTool = (call: ReturnType<typeof clientFor>, name: string, args: Record<string, unknown> = {}) => call("tools/call", { name, arguments: args });

describe("the MCP server", () => {
  it("lists its tools, with their annotations", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { tools } = await clientFor(workspaceId, userId)("tools/list");
    const names = tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["list_connectors", "connect_service", "search_registry", "create_list", "add_companies_to_list", "read_signals", "suppress", "figures"]));
    expect(tools.find((tool: { name: string }) => tool.name === "disconnect_service").annotations.destructiveHint).toBe(true);
  });

  it("says where to connect a service, and never asks for its secrets", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const call = clientFor(workspaceId, userId);
    const result = await callTool(call, "connect_service", { kind: "brevo_sms" });
    expect(result.structuredContent).toMatchObject({ kind: "brevo_sms", url: "https://coldlyne.test/connections/brevo_sms" });
    const refused = await callTool(call, "connect_service", { kind: "nope" });
    expect(refused.isError).toBe(true);
  });

  it("doesn't offer what signs in through an app this instance hasn't registered", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const call = clientFor(workspaceId, userId);
    const listed = await callTool(call, "list_connectors", { category: "email" });
    expect(listed.structuredContent.connectors.map((connector: { kind: string }) => connector.kind)).not.toContain("gmail");
    expect((await callTool(call, "connect_service", { kind: "gmail" })).isError).toBe(true);
  });

  it("goes from a registry search to a list of people, leaving out who refused", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const call = clientFor(workspaceId, userId);
    const search = await callTool(call, "search_registry", { activities: ["64.20Z"], department: "69" });
    expect(search.structuredContent.companies[0]).toMatchObject({ siren: "900000001", mayBeProspected: true, directors: [{ lastName: "Dupont-Martin" }] });

    const { listId } = (await callTool(call, "create_list", { name: "Holdings du Rhône" })).structuredContent;
    const added = await callTool(call, "add_companies_to_list", { listId, sirens: ["900000001", "900000002"] });
    expect(added.structuredContent).toEqual({ added: 1, skipped: [], notFound: ["900000002"] });
    const { prospects } = (await callTool(call, "list_prospects", { listId })).structuredContent;
    expect(prospects).toMatchObject([{ lastName: "Dupont-Martin", company: "ACME HOLDING" }]);
  });

  it("keeps a suppression, for every channel", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const call = clientFor(workspaceId, userId);
    await callTool(call, "suppress", { value: " Ada@Acme.fr " });
    expect((await callTool(call, "list_suppressed")).structuredContent.suppressed).toMatchObject([{ value: "ada@acme.fr", reason: "asked" }]);
  });

  it("stays inside the member's workspace", async () => {
    const mine = await createTestWorkspace(db);
    const theirs = await createTestWorkspace(db, "Other");
    const list = await createList(db, mine.workspaceId, "Mine");
    const call = clientFor(theirs.workspaceId, theirs.userId);
    expect((await callTool(call, "list_lists")).structuredContent.lists).toEqual([]);
    expect((await callTool(call, "list_prospects", { listId: list })).structuredContent.prospects).toEqual([]);
  });

  it("reports figures and what came back, empty at first", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const call = clientFor(workspaceId, userId);
    expect((await callTool(call, "read_signals")).structuredContent.signals).toEqual([]);
    expect((await callTool(call, "figures")).structuredContent).toMatchObject({ prospects: [], sent: [], signals: [] });
    expect((await callTool(call, "list_connections")).structuredContent.connections).toEqual([]);
    expect((await callTool(call, "list_connectors", { category: "sms" })).structuredContent.connectors.map((connector: { kind: string }) => connector.kind)).toEqual(["brevo_sms", "ovh_sms", "smsmode"]);
    expect(await callTool(call, "sync_now")).toMatchObject({ structuredContent: { read: 0, added: 0, failing: [] } });
  });
});

describe("campaigns through an assistant", () => {
  const STEP = { channel: "email", subject: "Bonjour {{firstName}}", body: "Une idée pour {{company}}." };

  async function ready(approval: "autonomous" | "approve_first" = "autonomous") {
    const { workspaceId, userId } = await createTestWorkspace(db);
    await saveSettings(db, workspaceId, { senderName: "NORTHWIND", senderAddress: "1 rue de la Paix, 75002 Paris", approval });
    return { workspaceId, userId, call: clientFor(workspaceId, userId) };
  }

  it("starts from a brief it can read and add to, without touching how the workspace sends", async () => {
    const { call, workspaceId } = await ready("approve_first");
    expect((await callTool(call, "read_brief", {})).structuredContent).toMatchObject({ brief: {}, approval: "approve_first", mailboxDailyCap: 40, senderSet: true, settingsPage: "https://coldlyne.test/settings" });
    await callTool(call, "save_brief", { target: "Holdings du Rhône" });
    await callTool(call, "save_brief", { tone: "Direct" });
    expect((await callTool(call, "read_brief", {})).structuredContent).toMatchObject({ brief: { target: "Holdings du Rhône", tone: "Direct" }, approval: "approve_first" });
    expect((await settingsOf(db, workspaceId)).approval).toBe("approve_first");
  });

  it("offers no tool that loosens how a workspace sends", async () => {
    const { call } = await ready();
    const { tools } = await call("tools/list");
    const names = tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["create_sequence", "launch_sequence", "approve_messages", "todays_tasks", "list_conversations", "create_watchlist", "read_brief"]));
    expect(names.filter((name: string) => /setting|approval_mode|cap|resume_mailbox/.test(name))).toEqual([]);
    for (const name of ["launch_sequence", "approve_messages", "reply_to_prospect", "remove_step", "resume_sequence", "delete_watchlist"]) expect(tools.find((tool: { name: string }) => tool.name === name).annotations.destructiveHint).toBe(true);
  });

  it("drafts a sequence that can't launch until it's ready, and says what's missing", async () => {
    const { call } = await ready();
    const created = await callTool(call, "create_sequence", { name: "Holdings", steps: [STEP] });
    const { sequenceId } = created.structuredContent;
    expect(created.structuredContent.url).toBe(`https://coldlyne.test/sequences/${sequenceId}`);
    const refused = await callTool(call, "launch_sequence", { sequenceId });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("Personne n’attend");
    expect((await callTool(call, "create_sequence", { name: " ", steps: [STEP] })).isError).toBe(true);
    expect((await callTool(call, "read_sequence", { sequenceId: crypto.randomUUID() })).isError).toBe(true);
  });

  it("edits a sequence, and enrolls a list or nobody with reasons", async () => {
    const { call, workspaceId } = await ready();
    const { sequenceId } = (await callTool(call, "create_sequence", { name: "Holdings", steps: [STEP] })).structuredContent;
    const listId = await createList(db, workspaceId, "Liste");
    await addFromRegistry(db, workspaceId, listId, [fromRegistry(holding())]);
    const added = await callTool(call, "add_step", { sequenceId, channel: "linkedin", waitDays: 2, body: "Bonjour" });
    const { steps } = (await callTool(call, "read_sequence", { sequenceId })).structuredContent;
    expect(steps.map((step: { channel: string }) => step.channel)).toEqual(["email", "linkedin"]);
    expect((await callTool(call, "update_step", { stepId: added.structuredContent.stepId, body: "Bonsoir" })).isError).toBeFalsy();
    expect((await callTool(call, "remove_step", { stepId: added.structuredContent.stepId })).isError).toBeFalsy();
    expect((await callTool(call, "remove_step", { stepId: added.structuredContent.stepId })).isError).toBe(true);
    expect((await callTool(call, "update_sequence", { sequenceId, name: "Renommée" })).isError).toBeFalsy();
    expect((await callTool(call, "enroll_prospects", { sequenceId, listId })).structuredContent).toMatchObject({ enrolled: 1, skipped: [] });
    expect((await callTool(call, "enroll_prospects", { sequenceId, listId })).structuredContent).toMatchObject({ enrolled: 0, skipped: [{ why: expect.stringContaining("déjà sur cette séquence") }] });
    expect((await callTool(call, "enroll_prospects", { sequenceId: crypto.randomUUID(), prospectIds: [] })).isError).toBe(true);
    const people = (await callTool(call, "list_people_on_sequence", { sequenceId })).structuredContent.people;
    expect(people[0]).toMatchObject({ status: "active", nextDueAt: null });
    expect((await callTool(call, "list_sequences", {})).structuredContent.sequences[0]).toMatchObject({ name: "Renommée", status: "draft", people: 1 });
    const stepId = steps[0].id;
    expect((await callTool(call, "write_message", { enrollmentId: people[0].enrollmentId, stepId, body: "Sur mesure" })).isError).toBeFalsy();
    expect((await callTool(call, "write_message", { enrollmentId: crypto.randomUUID(), stepId, body: "Sur mesure" })).isError).toBe(true);
    expect((await callTool(call, "remove_from_sequence", { enrollmentId: people[0].enrollmentId })).isError).toBeFalsy();
  });

  it("only pauses what runs, and has no messages to approve yet", async () => {
    const { call } = await ready();
    const { sequenceId } = (await callTool(call, "create_sequence", { name: "Holdings", steps: [STEP] })).structuredContent;
    expect((await callTool(call, "pause_sequence", { sequenceId })).isError).toBe(true);
    expect((await callTool(call, "resume_sequence", { sequenceId })).isError).toBe(true);
    expect((await callTool(call, "messages_to_approve", {})).structuredContent).toEqual({ messages: [] });
    expect((await callTool(call, "approve_messages", { messageIds: [crypto.randomUUID()] })).structuredContent).toEqual({ approved: 0 });
  });

  it("reads conversations and tasks, and says when there's nothing to act on", async () => {
    const { call } = await ready();
    const nobody = crypto.randomUUID();
    expect((await callTool(call, "todays_tasks", {})).structuredContent).toEqual({ tasks: [] });
    expect((await callTool(call, "list_conversations", {})).structuredContent).toEqual({ conversations: [] });
    for (const [tool, input] of [["read_thread", { prospectId: nobody }], ["set_interest", { prospectId: nobody, interest: "interested" }], ["reply_to_prospect", { prospectId: nobody, body: "x" }], ["record_reply", { prospectId: nobody, channel: "linkedin", text: "x" }], ["record_whatsapp_consent", { prospectId: nobody, agreed: true }], ["complete_task", { taskId: nobody, outcome: "done" }]] as const) {
      expect((await callTool(call, tool, input)).isError).toBe(true);
    }
  });

  it("watches for new prospects, and checks a domain takes mail", async () => {
    const { call, workspaceId } = await ready();
    const listId = await createList(db, workspaceId, "Veille");
    const { watchlistId } = (await callTool(call, "create_watchlist", { name: "Créations", listId, families: ["creation"], department: "69", activities: ["64.20Z"] })).structuredContent;
    expect((await callTool(call, "list_watchlists", {})).structuredContent.watchlists[0]).toMatchObject({ name: "Créations", query: { families: ["creation"], department: "69", activities: ["64.20Z"] } });
    expect((await callTool(call, "run_watchlist", { watchlistId: crypto.randomUUID() })).isError).toBe(true);
    expect((await callTool(call, "delete_watchlist", { watchlistId })).isError).toBeFalsy();
    expect((await callTool(call, "delete_watchlist", { watchlistId })).isError).toBe(true);
  });
});
