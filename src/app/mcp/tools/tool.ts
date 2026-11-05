import type { McpServer } from "@modelcontextprotocol/server";
import type { Services } from "@/application/services";

/** Who is asking and where: every tool runs as the signed-in member, inside one workspace of theirs. */
export interface ToolContext {
  services: Services;
  workspaceId: string;
  userId: string;
  /** They belong to others as well: a page of the app must say which workspace it's about. */
  severalWorkspaces?: boolean;
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

/**
 * A page of the app, for what must be done there (typing a secret, signing in to a provider). The
 * screens work in the browser's workspace, not the call's, so with several the link goes through it:
 * a mailbox meant for one company mustn't get connected to the one the browser happened to be on.
 */
export function appUrl(context: ToolContext, path: string): string {
  const page = context.severalWorkspaces ? `/workspace/${context.workspaceId}?${new URLSearchParams({ next: path })}` : path;
  return new URL(page, context.services.settings.BETTER_AUTH_URL).toString();
}
