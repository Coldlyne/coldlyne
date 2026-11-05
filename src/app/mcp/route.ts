import { createMcpHandler } from "@modelcontextprotocol/server";
import { workspacesOf } from "@/application/workspaces";
import { memberOfToken } from "@/infrastructure/auth/server";
import { db } from "@/infrastructure/db/client";
import { env } from "@/infrastructure/env";
import { appServices } from "@/infrastructure/services";
import { answerInFull } from "./answer-in-full";
import { coldlyneServer } from "./server";

/** Where an assistant learns how to sign in, per the MCP authorization spec (RFC 9728). */
const resourceMetadataUrl = () => new URL("/.well-known/oauth-protected-resource/mcp", env().BETTER_AUTH_URL).toString();

function unauthorized(detail: string): Response {
  return Response.json(
    { error: "unauthorized", error_description: detail },
    { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl()}"`, "Access-Control-Expose-Headers": "WWW-Authenticate" } },
  );
}

const handler = createMcpHandler(({ authInfo }) => {
  const { userId, workspaceId } = (authInfo?.extra ?? {}) as { userId: string; workspaceId: string };
  return coldlyneServer({ services: appServices(), workspaceId, userId });
});

/**
 * The MCP endpoint. Each request is verified on its own and served by a fresh server bound to
 * the member's workspace, so nothing about one member can reach another's tools.
 */
async function serve(request: Request): Promise<Response> {
  const member = await memberOfToken(request, env()).catch(() => null);
  if (!member) return unauthorized("Sign in to Coldlyne to use this server.");
  const [workspace] = await workspacesOf(db(), member.userId);
  // Not a 401: signing in again wouldn't help, and an assistant would loop on it.
  if (!workspace) return Response.json({ error: "no_workspace", error_description: `Create your workspace first: ${env().BETTER_AUTH_URL}/welcome` }, { status: 403 });
  const token = request.headers.get("authorization")?.split(" ")[1] ?? "";
  return answerInFull(request, (whole) => handler.fetch(whole, { authInfo: { token, clientId: member.clientId, scopes: [], extra: { userId: member.userId, workspaceId: workspace.id } } }));
}

export const GET = serve;
export const POST = serve;
export const DELETE = serve;
