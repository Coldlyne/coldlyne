import { connection } from "next/server";
import { mcpResource, tokenIssuer } from "@/infrastructure/auth/server";
import { env } from "@/infrastructure/env";

/**
 * What an assistant reads after a 401 from /api/mcp (RFC 9728): the resource it is reaching, and
 * which server signs tokens for it. The issuer is Better Auth's, under its base path.
 */
export async function GET() {
  await connection();
  const settings = env();
  return Response.json({
    resource: mcpResource(settings),
    authorization_servers: [tokenIssuer(settings)],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "profile", "email", "offline_access"],
    resource_name: "Coldlyne",
  });
}
