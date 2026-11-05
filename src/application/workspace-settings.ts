import { and, eq, sql } from "drizzle-orm";
import { DEFAULT_DAILY_CAP, type SenderIdentity } from "@/domain/sequences";
import type { Database } from "@/infrastructure/db/client";
import { workspaceSettings, type WorkspaceBrief } from "@/infrastructure/db/schema/sequences";
import { member } from "@/infrastructure/db/schema/tenancy";
import { withWorkspace } from "@/infrastructure/db/tenant";

export type { WorkspaceBrief };

export interface WorkspaceSettings {
  approval: "autonomous" | "approve_first";
  senderName: string | null;
  senderAddress: string | null;
  mailboxDailyCap: number;
  brief: WorkspaceBrief;
}

const DEFAULTS: WorkspaceSettings = { approval: "autonomous", senderName: null, senderAddress: null, mailboxDailyCap: DEFAULT_DAILY_CAP, brief: {} };

/** How this workspace sends, with the defaults until a member changes them. */
export async function settingsOf(db: Database, workspaceId: string): Promise<WorkspaceSettings> {
  const [row] = await withWorkspace(db, workspaceId, (tx) => tx.select().from(workspaceSettings));
  return row ? { approval: row.approval, senderName: row.senderName, senderAddress: row.senderAddress, mailboxDailyCap: row.mailboxDailyCap, brief: row.brief } : DEFAULTS;
}

/** A member's changes. No assistant tool reaches this: a prompt can't loosen how a workspace sends. */
export async function saveSettings(db: Database, workspaceId: string, changes: Partial<WorkspaceSettings>): Promise<void> {
  await withWorkspace(db, workspaceId, (tx) =>
    tx
      .insert(workspaceSettings)
      .values({ ...changes })
      .onConflictDoUpdate({ target: workspaceSettings.workspaceId, set: { ...changes, updatedAt: sql`now()` } }),
  );
}

/** Who the law says each message must name, once a member told Coldlyne. */
export const senderOf = ({ senderName, senderAddress }: Pick<WorkspaceSettings, "senderName" | "senderAddress">): SenderIdentity | null => (senderName?.trim() && senderAddress?.trim() ? { name: senderName.trim(), address: senderAddress.trim() } : null);

/** The number a member's calls ring first. */
export async function memberPhoneOf(db: Database, workspaceId: string, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ phone: member.phone })
    .from(member)
    .where(and(eq(member.workspaceId, workspaceId), eq(member.userId, userId)));
  return row?.phone ?? null;
}

export async function saveMemberPhone(db: Database, workspaceId: string, userId: string, phone: string | null): Promise<void> {
  await db
    .update(member)
    .set({ phone })
    .where(and(eq(member.workspaceId, workspaceId), eq(member.userId, userId)));
}
