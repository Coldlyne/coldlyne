import { desc, eq, sql } from "drizzle-orm";
import { managesApiKeys, NOT_A_MANAGER_OF_KEYS } from "@/domain/team";
import { randomToken, sha256 } from "@/infrastructure/crypto/secrets";
import { apiKey } from "@/infrastructure/db/schema/connections";
import { withWorkspace } from "@/infrastructure/db/tenant";
import type { Database } from "@/infrastructure/db/client";
import type { Tried } from "./connection-use";
import { roleIn } from "./team";

/** Keys start with this, so one pasted somewhere it shouldn't be is recognisable. */
const PREFIX = "cl_";

/** All a key can do, whoever made it: the one route that takes keys reads figures. It's said rather than stored, since no key differs. */
export const KEY_SCOPES = ["figures:read"] as const;

export type NewKey = { ok: true; id: string; key: string } | { ok: false; error: string };

/** A new key for another app (a dashboard) to read the workspace's figures. Only its hash is kept: the key is shown once. */
export async function createApiKey(db: Database, workspaceId: string, userId: string, name: string): Promise<NewKey> {
  if (!managesApiKeys(await roleIn(db, workspaceId, userId))) return { ok: false, error: NOT_A_MANAGER_OF_KEYS };
  const key = `${PREFIX}${randomToken(30)}`;
  const [row] = await withWorkspace(db, workspaceId, (tx) => tx.insert(apiKey).values({ name: name.trim() || "Clé", keyHash: sha256(key), prefix: key.slice(0, 10), createdBy: userId }).returning({ id: apiKey.id }));
  return { ok: true, id: row.id, key };
}

export async function apiKeysOf(db: Database, workspaceId: string) {
  return withWorkspace(db, workspaceId, (tx) => tx.select({ id: apiKey.id, name: apiKey.name, prefix: apiKey.prefix, lastUsedAt: apiKey.lastUsedAt, createdAt: apiKey.createdAt }).from(apiKey).orderBy(desc(apiKey.createdAt)));
}

/** The keys, for someone asking through a tool: only who could make or end one may see them there. */
export async function apiKeysForManager(db: Database, workspaceId: string, userId: string) {
  if (!managesApiKeys(await roleIn(db, workspaceId, userId))) return { ok: false as const, error: NOT_A_MANAGER_OF_KEYS };
  return { ok: true as const, keys: await apiKeysOf(db, workspaceId) };
}

/** Ends a key for good: its row goes, and whatever read with it stops at once. Another workspace's key is no key at all from here. */
export async function revokeApiKey(db: Database, workspaceId: string, userId: string, id: string): Promise<Tried> {
  if (!managesApiKeys(await roleIn(db, workspaceId, userId))) return { ok: false, error: NOT_A_MANAGER_OF_KEYS };
  const ended = await withWorkspace(db, workspaceId, (tx) => tx.delete(apiKey).where(eq(apiKey.id, id)).returning({ id: apiKey.id }));
  return ended.length > 0 ? { ok: true, said: "Clé révoquée." } : { ok: false, error: "Cette clé n’existe pas dans cet espace." };
}

/** The workspace a key belongs to, or null; read by hash before any workspace is known (trusted path). */
export async function workspaceOfKey(db: Database, key: string | null): Promise<string | null> {
  if (!key?.startsWith(PREFIX)) return null;
  const [row] = await db.update(apiKey).set({ lastUsedAt: sql`now()` }).where(eq(apiKey.keyHash, sha256(key))).returning({ workspaceId: apiKey.workspaceId });
  return row?.workspaceId ?? null;
}
