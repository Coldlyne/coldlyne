import { sql } from "drizzle-orm";
import { index, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { createdAt, tenantIsolation, workspaceColumn } from "./shared";

// ─── Workspaces and their members ──────────────────────────────────────────
//
// Read by the trusted server path to find whose workspace a request is in, before it is bound to
// one: no row-level security here, and the app role can't write them.

export const workspace = pgTable("workspace", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  createdAt: createdAt(),
});

export const memberRole = pgEnum("member_role", ["owner", "admin", "member"]);

export const member = pgTable(
  "member",
  {
    workspaceId: uuid()
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: memberRole().notNull().default("member"),
    /** The number a call rings first: a member is always on the line. */
    phone: text(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.userId] })],
);

// ─── Invitations ───────────────────────────────────────────────────────────
//
// Someone asked to join a workspace, perhaps before they have an account. Unlike the tables above,
// a workspace's screens read and write its own behind row-level security; only the sign-up gate and
// the link come before any workspace is known, on the trusted path.

export const invitation = pgTable(
  "invitation",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceColumn().references(() => workspace.id, { onDelete: "cascade" }),
    /** Lowercased: the one address the link lets in. */
    email: text().notNull(),
    role: memberRole().notNull().default("member"),
    /** Only the hash is kept: the link itself is shown or mailed once. */
    tokenHash: text().notNull().unique(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    invitedBy: text().references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    acceptedAt: timestamp({ withTimezone: true }),
  },
  (table) => [
    // One open invitation per address: inviting again replaces it, so an old link stops working.
    uniqueIndex().on(table.workspaceId, table.email).where(sql`accepted_at is null`),
    index().on(table.email),
    tenantIsolation(),
  ],
).enableRLS();
