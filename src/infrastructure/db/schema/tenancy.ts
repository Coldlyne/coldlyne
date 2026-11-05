import { pgEnum, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { createdAt } from "./shared";

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
