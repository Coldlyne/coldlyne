import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { answerInFull } from "@/app/mcp/answer-in-full";

const post = (method: string) =>
  new Request("https://coldlyne.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: method === "tools/call" ? { name: "slow", arguments: {} } : {} }),
  });

/** A tool that takes a moment, as today's clients reach it: a stream handed back with the tool running behind it. */
function slowTool() {
  const seen = { finished: false };
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "test", version: "1" });
    server.registerTool("slow", { inputSchema: z.object({}) }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      seen.finished = true;
      return { content: [{ type: "text", text: "fait" }] };
    });
    return server;
  });
  return { seen, respond: (request: Request) => handler.fetch(request) };
}

describe("an assistant's call to a tool", () => {
  it("would otherwise come back before the tool has run, too late to clear the cache", async () => {
    const { seen, respond } = slowTool();
    const response = await respond(post("tools/call"));
    expect(seen.finished).toBe(false);
    await response.text();
  });

  it("only comes back once the tool has run, with its whole answer", async () => {
    const { seen, respond } = slowTool();
    const response = await answerInFull(post("tools/call"), respond);
    expect(seen.finished).toBe(true);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain("fait");
  });

  it("holds nothing else back: a client's listening stream never ends", async () => {
    const forever = new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
    await expect(answerInFull(post("subscriptions/listen"), async () => forever)).resolves.toBe(forever);
  });

  it("leaves a body it can't read to the server, which refuses it", async () => {
    const refused = Response.json({ error: "bad" }, { status: 400 });
    const request = new Request("https://coldlyne.test/mcp", { method: "POST", body: "pas du json" });
    await expect(answerInFull(request, async () => refused)).resolves.toBe(refused);
  });
});
