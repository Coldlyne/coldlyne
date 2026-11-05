import type { McpServer } from "@modelcontextprotocol/server";
import type { Services } from "@/application/services";

/** Who is asking and where: every tool runs as the signed-in member, inside their workspace. */
export interface ToolContext {
  services: Services;
  workspaceId: string;
  userId: string;
}

export type ToolRegistrar = (server: McpServer, context: ToolContext) => void;

/** A tool's answer: readable text for the assistant, and the same data structured. */
export function answer(data: Record<string, unknown>, summary?: string) {
  const text = summary ? `${summary}\n\n${JSON.stringify(data, null, 2)}` : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text }], structuredContent: data };
}

/** A refusal or a failure, said plainly so the assistant can relay it or fix its call. */
export function refusal(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

/** A page of the app, for what must be done there (typing a secret, signing in to a provider). */
export const appUrl = (context: ToolContext, path: string) => new URL(path, context.services.settings.BETTER_AUTH_URL).toString();
