import { sql } from "drizzle-orm";
import { index, pgEnum, pgPolicy, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { appRole, createdAt, currentDirectory, tenantIsolation, workspaceColumn } from "./shared";

// ─── Groups of workspaces ──────────────────────────────────────────────────
//
// What the workspaces of a group share: the companies they prospect and the people there, found once.
// Someone running several businesses shouldn't find and keep the same companies several times, and
// one customer's prospects must never reach another's, so a group is explicit: a workspace is in a new
// one unless someone who owns a workspace of an existing one says otherwise, and an owner can run
// several. The screens and tools say "group"; the code and the database say "directory".
// Only the trusted server path touches this table: the app role has no grant on it.

export const directory = pgTable("directory", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  createdAt: createdAt(),
}).enableRLS();

// ─── Workspaces and their members ──────────────────────────────────────────
//
// Read by the trusted server path to find whose workspace a request is in, before it is bound to
// one, which row-level security doesn't apply to. Once bound, the app role can only read: its
// directory's workspaces, for their names, and its own workspace's members. It can write neither,
// so nothing a workspace does can move it into another directory.

export const workspace = pgTable(
  "workspace",
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    slug: text().notNull().unique(),
    /** Its group, fixed when the workspace starts: no tool and no screen changes it. */
    directoryId: uuid()
      .notNull()
      .references(() => directory.id),
    createdAt: createdAt(),
  },
  (table) => [index().on(table.directoryId), pgPolicy("directory_isolation", { for: "select", to: appRole, using: sql`${table.directoryId} = ${currentDirectory}` })],
).enableRLS();

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
  (table) => [primaryKey({ columns: [table.workspaceId, table.userId] }), tenantIsolation()],
).enableRLS();

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
