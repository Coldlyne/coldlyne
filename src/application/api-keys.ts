import { desc, eq, sql } from "drizzle-orm";
import { randomToken, sha256 } from "@/infrastructure/crypto/secrets";
import { apiKey } from "@/infrastructure/db/schema/connections";
import { withWorkspace } from "@/infrastructure/db/tenant";
import type { Database } from "@/infrastructure/db/client";

/** Keys start with this, so one pasted somewhere it shouldn't be is recognisable. */
const PREFIX = "cl_";

/** A new key for another app (a dashboard) to read the workspace's figures. Only its hash is kept: the key is shown once. */
export async function createApiKey(db: Database, workspaceId: string, userId: string, name: string): Promise<{ id: string; key: string }> {
  const key = `${PREFIX}${randomToken(30)}`;
  const [row] = await withWorkspace(db, workspaceId, (tx) => tx.insert(apiKey).values({ name: name.trim() || "Clé", keyHash: sha256(key), prefix: key.slice(0, 10), createdBy: userId }).returning({ id: apiKey.id }));
  return { id: row.id, key };
}

export async function apiKeysOf(db: Database, workspaceId: string) {
  return withWorkspace(db, workspaceId, (tx) => tx.select({ id: apiKey.id, name: apiKey.name, prefix: apiKey.prefix, lastUsedAt: apiKey.lastUsedAt, createdAt: apiKey.createdAt }).from(apiKey).orderBy(desc(apiKey.createdAt)));
}

export async function revokeApiKey(db: Database, workspaceId: string, id: string): Promise<boolean> {
  return (await withWorkspace(db, workspaceId, (tx) => tx.delete(apiKey).where(eq(apiKey.id, id)).returning({ id: apiKey.id }))).length > 0;
}

/** The workspace a key belongs to, or null; read by hash before any workspace is known (trusted path). */
export async function workspaceOfKey(db: Database, key: string | null): Promise<string | null> {
  if (!key?.startsWith(PREFIX)) return null;
  const [row] = await db.update(apiKey).set({ lastUsedAt: sql`now()` }).where(eq(apiKey.keyHash, sha256(key))).returning({ workspaceId: apiKey.workspaceId });
  return row?.workspaceId ?? null;
}
