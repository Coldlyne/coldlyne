import { workspaceOfKey } from "@/application/api-keys";
import { figuresOf } from "@/application/figures";
import { db } from "@/infrastructure/db/client";

const DAY_MS = 86_400_000;

/** A workspace's figures, for another app holding one of its keys. */
export async function GET(request: Request) {
  const key = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
  const workspaceId = await workspaceOfKey(db(), key);
  if (!workspaceId) return Response.json({ error: "Clé d’API absente ou refusée." }, { status: 401 });
  const days = Math.min(Math.max(Number(new URL(request.url).searchParams.get("days")) || 30, 1), 365);
  return Response.json(await figuresOf(db(), workspaceId, new Date(Date.now() - days * DAY_MS)));
}
