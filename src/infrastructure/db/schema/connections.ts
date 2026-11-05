import { index, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { prospect } from "./prospects";
import { enrollment } from "./sequences";
import { createdAt, tenantIsolation, updatedAt, workspaceColumn } from "./shared";

// ─── Connections ───────────────────────────────────────────────────────────
//
// The services a workspace connected (its mailboxes, SMS provider, CRM…), what came back from
// them, and the keys other apps read Coldlyne with. Credentials are sealed per row
// (see infrastructure/crypto), never kept in environment variables.

export const connectionStatus = pgEnum("connection_status", ["connected", "failing"]);

export const connection = pgTable(
  "connection",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceColumn(),
    /** The connector's kind in the catalogue (domain/connectors): gmail, brevo_sms, hubspot… */
    kind: text().notNull(),
    /** What to call it: the mailbox's address, the account's name. */
    label: text().notNull(),
    status: connectionStatus().notNull().default("connected"),
    /** Keys, tokens and passwords, sealed with the instance's secrets key. */
    sealedCredentials: text().notNull(),
    /** What isn't secret: a sender name, a caller number, a sheet's id… */
    settings: jsonb().$type<Record<string, string>>().notNull().default({}),
    /** Signs the address a service posts its webhooks to; checked before anything is read. */
    hookToken: text().notNull(),
    connectedBy: text().references(() => user.id, { onDelete: "set null" }),
    checkedAt: timestamp({ withTimezone: true }),
    /** Up to when replies, meetings and incoming SMS were read: the next read starts there. */
    syncedAt: timestamp({ withTimezone: true }),
    /** The last check's answer when it failed, in the member's words. */
    lastError: text(),
    /** A mailbox stopped because it was hurting its domain: it sends nothing until a member resumes it. */
    pausedAt: timestamp({ withTimezone: true }),
    pausedReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [unique().on(table.workspaceId, table.kind, table.label), tenantIsolation()],
).enableRLS();

export const signalType = pgEnum("signal_type", [
  "replied",
  "auto_reply",
  "bounced",
  "opted_out",
  "delivered",
  "failed",
  "answered",
  "no_answer",
  "voicemail_left",
  "meeting_booked",
  "meeting_cancelled",
  "signed_up",
]);

/**
 * Something a prospect did, as a connected service reported it: a reply, a bounce, a STOP, a
 * call's outcome, a meeting, a sign-up. Sequences stop on it and the figures count it.
 */
export const signal = pgTable(
  "signal",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceColumn(),
    /** Left empty once the connection is removed: what it brought in still counts. */
    connectionId: uuid().references(() => connection.id, { onDelete: "set null" }),
    type: signalType().notNull(),
    channel: text().notNull(),
    /** The service's own id for it: the same event is recorded once. */
    externalId: text().notNull(),
    /** A lowercased email address or an E.164 number. */
    address: text(),
    at: timestamp({ withTimezone: true }).notNull(),
    detail: text(),
    inReplyTo: text(),
    createdAt: createdAt(),
  },
  (table) => [unique().on(table.connectionId, table.externalId), index().on(table.workspaceId, table.address), tenantIsolation()],
).enableRLS();

/**
 * Who the workspace reached out to, step by step. Reading a mailbox or a calendar sees everything
 * in it, most of it nothing to do with prospecting: only what answers one of these is kept.
 */
export const outreach = pgTable(
  "outreach",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceColumn(),
    connectionId: uuid().references(() => connection.id, { onDelete: "set null" }),
    channel: text().notNull(),
    /** A lowercased email address or an E.164 number. */
    address: text().notNull(),
    /** For email: the Message-ID, which a colleague's reply from another address still names. */
    messageId: text(),
    /** The provider's id for it. */
    externalId: text(),
    /** Who it was sent to on which sequence: what a reply to it stops. Empty for a test or a reply by hand. */
    enrollmentId: uuid().references(() => enrollment.id, { onDelete: "set null" }),
    sentAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [index().on(table.workspaceId, table.address), index().on(table.workspaceId, table.messageId), tenantIsolation()],
).enableRLS();

/** A key another app reads a workspace's figures with (a dashboard); only its hash is kept. */
export const apiKey = pgTable(
  "api_key",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceColumn(),
    name: text().notNull(),
    /** SHA-256 of the key, hex; the key itself is shown once, when it is made. */
    keyHash: text().notNull().unique(),
    /** The key's first characters, to tell keys apart in the list. */
    prefix: text().notNull(),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    lastUsedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [index().on(table.workspaceId), tenantIsolation()],
).enableRLS();

/** A short-lived record of a connection being authorized with a provider (OAuth's state and PKCE verifier). */
export const connectionGrant = pgTable(
  "connection_grant",
  {
    state: text().primaryKey(),
    workspaceId: workspaceColumn(),
    kind: text().notNull(),
    codeVerifier: text().notNull(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  () => [tenantIsolation()],
).enableRLS();

/** What was sent to a CRM: what the list shows, and what keeps a retry from adding the same note twice. */
export const crmPush = pgTable(
  "crm_push",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceColumn(),
    connectionId: uuid()
      .notNull()
      .references(() => connection.id, { onDelete: "cascade" }),
    prospectId: uuid()
      .notNull()
      .references(() => prospect.id, { onDelete: "cascade" }),
    /** The person's id in the CRM. */
    externalId: text().notNull(),
    /** The note's hash, empty when none was added: a different note is a new push. */
    noteHash: text().notNull(),
    pushedAt: timestamp({ withTimezone: true }).notNull(),
  },
  (table) => [unique().on(table.connectionId, table.prospectId, table.noteHash), tenantIsolation()],
).enableRLS();
