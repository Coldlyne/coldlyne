import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import type { BodaccFamily } from "@/domain/bodacc";
import type { SendingWindow, StepCondition } from "@/domain/sequences";
import { user } from "./auth";
import { connection } from "./connections";
import { company, person, prospect, prospectList } from "./prospects";
import { createdAt, tenantIsolation, updatedAt, workspaceColumn } from "./shared";

// ─── Sequences ─────────────────────────────────────────────────────────────
//
// How a workspace reaches its prospects: its sending rules, the sequences it runs and their steps,
// who is on each, and every message that came of it. What is sent, approved or skipped stays here
// as the record of what was done, and by whom.

export const approvalMode = pgEnum("approval_mode", ["autonomous", "approve_first"]);

/** What an assistant needs to write as the business, and can't guess: read at the start of a conversation. */
export interface WorkspaceBrief {
  target?: string;
  offer?: string;
  proof?: string;
  tone?: string;
  avoid?: string;
}

/** How a workspace sends. Only a member changes it, on its page: an assistant reads it and can't loosen it. */
export const workspaceSettings = pgTable(
  "workspace_settings",
  {
    workspaceId: workspaceColumn().primaryKey(),
    approval: approvalMode().notNull().default("autonomous"),
    /** Who the law says each message must name: a legal name and a postal address. */
    senderName: text(),
    senderAddress: text(),
    mailboxDailyCap: integer().notNull().default(40),
    brief: jsonb().$type<WorkspaceBrief>().notNull().default({}),
    updatedAt: updatedAt(),
  },
  () => [tenantIsolation()],
).enableRLS();

export const sequenceStatus = pgEnum("sequence_status", ["draft", "pending_approval", "running", "paused", "finished"]);

/** Which connections a sequence sends through: several mailboxes share its email, one provider each for the rest. */
export interface SequenceChannels {
  email?: string[];
  sms?: string;
  letter?: string;
  whatsapp?: string;
  call?: string;
}

export const sequence = pgTable(
  "sequence",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceColumn(),
    name: text().notNull(),
    status: sequenceStatus().notNull().default("draft"),
    channels: jsonb().$type<SequenceChannels>().notNull().default({}),
    window: jsonb().$type<SendingWindow>().notNull(),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    launchedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index().on(table.workspaceId, table.status), tenantIsolation()],
).enableRLS();

/** What only some channels need: an approved WhatsApp template, a recorded voicemail. */
export interface StepOptions {
  template?: string;
  language?: string;
  parameters?: string[];
  recordingUrl?: string;
}

/** One step of a sequence. Positions leave gaps when a step is removed: people already past it stay where they are. */
export const sequenceStep = pgTable(
  "sequence_step",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceColumn(),
    sequenceId: uuid()
      .notNull()
      .references(() => sequence.id, { onDelete: "cascade" }),
    position: integer().notNull(),
    channel: text().notNull(),
    /** Days after the step before it ended. */
    waitDays: integer().notNull().default(0),
    condition: text().$type<StepCondition>().notNull().default("always"),
    subject: text(),
    body: text().notNull(),
    options: jsonb().$type<StepOptions>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index().on(table.sequenceId, table.position), tenantIsolation()],
).enableRLS();

/** `active` waits for its date; `waiting_member` for a person: a task to do, or a message to correct. */
export const enrollmentStatus = pgEnum("enrollment_status", ["active", "waiting_member", "stopped", "finished"]);

/** Someone on a sequence, and where they are with it. One thread: their mailbox doesn't change once chosen. */
export const enrollment = pgTable(
  "enrollment",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceColumn(),
    sequenceId: uuid()
      .notNull()
      .references(() => sequence.id, { onDelete: "cascade" }),
    prospectId: uuid()
      .notNull()
      .references(() => prospect.id, { onDelete: "cascade" }),
    /** Kept here so a reply can stop everyone at the same company, on every sequence. */
    personId: uuid()
      .notNull()
      .references(() => person.id, { onDelete: "cascade" }),
    companyId: uuid()
      .notNull()
      .references(() => company.id, { onDelete: "cascade" }),
    status: enrollmentStatus().notNull().default("active"),
    /** replied, colleague_replied, opted_out, bounced, suppressed, registry_opt_out, member. */
    stopReason: text(),
    lastPosition: integer().notNull().default(-1),
    /** How the last step ended, for the steps that depend on it. */
    lastOutcome: text(),
    nextDueAt: timestamp({ withTimezone: true }),
    mailboxId: uuid().references(() => connection.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [unique().on(table.sequenceId, table.prospectId), index().on(table.workspaceId, table.status, table.nextDueAt), index().on(table.companyId), index().on(table.personId), tenantIsolation()],
).enableRLS();

export const messageStatus = pgEnum("message_status", ["draft", "awaiting_approval", "approved", "sending", "sent", "failed", "skipped", "to_do", "done"]);

/**
 * What a step comes to for one person. Written ahead by an assistant or a member (`draft`), or made
 * from the step's text when it falls due. `sending` is claimed before the provider is called: a
 * crash leaves it there rather than risk writing to someone twice.
 */
export const stepMessage = pgTable(
  "step_message",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceColumn(),
    enrollmentId: uuid()
      .notNull()
      .references(() => enrollment.id, { onDelete: "cascade" }),
    /** Empty for a reply written by hand, or once its step was removed. */
    stepId: uuid().references(() => sequenceStep.id, { onDelete: "set null" }),
    channel: text().notNull(),
    subject: text(),
    body: text(),
    /** Who wrote it: the step's text (template), an assistant or a member. */
    writtenBy: text().$type<"template" | "assistant" | "member">().notNull().default("template"),
    status: messageStatus().notNull(),
    attempts: integer().notNull().default(0),
    connectionId: uuid().references(() => connection.id, { onDelete: "set null" }),
    /** The provider's id, and for email the Message-ID a reply names. */
    externalId: text(),
    messageId: text(),
    /** Why it failed or was skipped, in the member's words. */
    note: text(),
    /** How a call or a task ended, and what was said. */
    outcome: text(),
    summary: text(),
    assignedTo: text().references(() => user.id, { onDelete: "set null" }),
    approvedBy: text().references(() => user.id, { onDelete: "set null" }),
    doneBy: text().references(() => user.id, { onDelete: "set null" }),
    sentAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [unique().on(table.enrollmentId, table.stepId), index().on(table.workspaceId, table.status), index().on(table.assignedTo, table.status), index().on(table.externalId), tenantIsolation()],
).enableRLS();

/** What a watchlist looks for in BODACC's announcements, narrowed by what the registry says of each company. */
export interface WatchQuery {
  families?: BodaccFamily[];
  onlyDirectorChanges?: boolean;
  department?: string;
  words?: string;
  /** NAF codes (64.20Z) and legal form codes (5710): BODACC doesn't carry them, the registry does. */
  activities?: string[];
  legalForms?: string[];
}

/** A search that runs by itself: what it finds goes on a list, and the workspace hears about it. */
export const watchlist = pgTable(
  "watchlist",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceColumn(),
    name: text().notNull(),
    query: jsonb().$type<WatchQuery>().notNull(),
    listId: uuid()
      .notNull()
      .references(() => prospectList.id, { onDelete: "cascade" }),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    /** Up to when announcements were read: the next run starts there. */
    checkedUntil: timestamp({ withTimezone: true }),
    lastAdded: integer().notNull().default(0),
    lastError: text(),
    createdAt: createdAt(),
  },
  (table) => [index().on(table.workspaceId), tenantIsolation()],
).enableRLS();
