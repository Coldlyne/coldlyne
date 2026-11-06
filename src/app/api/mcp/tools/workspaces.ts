import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { MemberWorkspace } from "@/application/workspaces";
import { answer } from "./tool";

/** The one tool that isn't in a workspace: it says which there are. It only reads, and offers no way to change who belongs where. */
export function workspaceListTool(server: McpServer, workspaces: MemberWorkspace[]): void {
  server.registerTool(
    "list_workspaces",
    {
      title: "This member's workspaces",
      description: "The workspaces this member belongs to, one per company, with their role in each and the group each is in: workspaces of a group share what's known of companies and people. With several, every other tool says which one it acts in through its workspace argument.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => answer({ workspaces: workspaces.map(({ id, name, role, group }) => ({ id, name, role, group })) }),
  );
}
