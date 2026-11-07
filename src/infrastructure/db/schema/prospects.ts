import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgEnum, pgPolicy, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { appRole, createdAt, currentDirectory, directoryIsolation, tenantIsolation, tenantIsolationInDirectory, updatedAt, workspaceColumn } from "./shared";
import { directory } from "./tenancy";

// ─── Prospects ─────────────────────────────────────────────────────────────
//
// What a directory holds in common (companies, the people at them, their published details), and
// what stays each workspace's own: the lists it works through, who is on them, and who it must never
// write to again. Each row says where it came from. On a shared row, the workspace is the one that
// first brought it, and opens nothing.

export const prospectSource = pgEnum("prospect_source", ["registry", "import", "member"]);

/** The directory a shared row belongs to, filled from the transaction's workspace when left out. */
const directoryColumn = () =>
  uuid()
    .notNull()
    .default(sql`app_directory_id()`)
    .references(() => directory.id);

/** A company, as the French registry (or an import) describes it. One row per SIREN in a directory. */
export const company = pgTable(
  "company",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceColumn(),
    directoryId: directoryColumn(),
    siren: text(),
    name: text().notNull(),
    /** The registry's legal form code (5710 SAS, 5499 SARL…) and activity code (NAF, 64.20Z holdings). */
    legalForm: text(),
    activity: text(),
    /** The registered office's street: where a letter goes. */
    street: text(),
    postcode: text(),
    city: text(),
    /** When it was created, YYYY-MM-DD. */
    createdOn: text(),
    website: text(),
    /** It refused commercial use of its data in the registry: never prospected. */
    registryOptOut: boolean().notNull().default(false),
    /** When the registry last said all this: for a while, another workspace needn't ask again. */
    registryCheckedAt: timestamp({ withTimezone: true }),
    source: prospectSource().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique().on(table.directoryId, table.siren),
    // What code from before the directory still names when it adds a company: dropped, with its trigger, once every deployment has moved on.
    unique().on(table.workspaceId, table.siren),
    directoryIsolation(),
  ],
).enableRLS();

/** Someone at a company: from the registry, its directors (people, not companies). */
export const person = pgTable(
  "person",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceColumn(),
    directoryId: directoryColumn(),
    companyId: uuid()
      .notNull()
      .references(() => company.id, { onDelete: "cascade" }),
    firstName: text(),
    lastName: text().notNull(),
    /** Their role there, in the registry's words: Président, Gérant… */
    role: text(),
    /** How many active companies they direct, when looked up: some offers are for those who run several. */
    companiesDirected: integer(),
    /** No longer read, and emptied: consent is given to one business, see `whatsappConsent`. Dropped once every deployment has moved on. */
    whatsappConsentAt: timestamp({ withTimezone: true }),
    source: prospectSource().notNull(),
    createdAt: createdAt(),
  },
  (table) => [unique().on(table.companyId, table.firstName, table.lastName), index().on(table.workspaceId), index().on(table.directoryId), directoryIsolation()],
).enableRLS();

/** When someone agreed to WhatsApp messages. It is one business they said yes to, so it stays that workspace's: the Business API only ever writes to people who did. */
export const whatsappConsent = pgTable(
  "whatsapp_consent",
  {
    workspaceId: workspaceColumn(),
    personId: uuid()
      .notNull()
      .references(() => person.id, { onDelete: "cascade" }),
    agreedAt: timestamp({ withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.personId] }), tenantIsolation()],
).enableRLS();

/** A list of prospects a campaign works through. */
export const prospectList = pgTable(
  "prospect_list",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceColumn(),
    name: text().notNull(),
    createdAt: createdAt(),
  },
  (table) => [index().on(table.workspaceId), tenantIsolation()],
).enableRLS();

export const prospectState = pgEnum("prospect_state", ["new", "ready", "in_sequence", "replied", "bounced", "opted_out", "done"]);

/** What someone's reply came to, as the assistant or a member read it. */
export const prospectInterest = pgEnum("prospect_interest", ["interested", "not_now", "not_interested", "wrong_person"]);

/** A person on a list, and where they are with it. */
export const prospect = pgTable(
  "prospect",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceColumn(),
    listId: uuid()
      .notNull()
      .references(() => prospectList.id, { onDelete: "cascade" }),
    personId: uuid()
      .notNull()
      .references(() => person.id, { onDelete: "cascade" }),
    state: prospectState().notNull().default("new"),
    interest: prospectInterest(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [unique().on(table.listId, table.personId), tenantIsolation()],
).enableRLS();

/**
 * How to reach someone, with where it was found: nothing is guessed. On the list only once a
 * member confirmed it or brought it (a file they imported). What a page publishes is shared across
 * the directory. What came from a member's own file has no page, and stays with the workspace that
 * brought it: it may be private, and another workspace couldn't say where it got it from.
 */
export const contactDetail = pgTable(
  "contact_detail",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceColumn(),
    directoryId: directoryColumn(),
    personId: uuid()
      .notNull()
      .references(() => person.id, { onDelete: "cascade" }),
    /** email, phone, linkedin, instagram, facebook or x. */
    kind: text().notNull(),
    /** A lowercased address, an E.164 number, or a profile's canonical URL. */
    value: text().notNull(),
    /** The page it was found on; none when it came from the member's own file. */
    page: text(),
    source: text().$type<"website" | "import" | "member">().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex().on(table.personId, table.kind, table.value).where(sql`page is not null`),
    uniqueIndex().on(table.workspaceId, table.personId, table.kind, table.value).where(sql`page is null`),
    index().on(table.workspaceId),
    index().on(table.directoryId),
    tenantIsolationInDirectory(),
    pgPolicy("published_in_directory", { for: "select", to: appRole, using: sql`${table.page} is not null and ${table.directoryId} = ${currentDirectory}` }),
  ],
).enableRLS();

export const suppressionReason = pgEnum("suppression_reason", ["opted_out", "bounced", "asked", "member", "crm"]);

/**
 * An address or a whole domain the workspace never writes to again, from any of its mailboxes and
 * sending domains, and why. An opt-out is said to one workspace and stays there: another of the
 * directory learns of it (`elsewhereOf`) and decides. A bounce is a fact about the address, whoever
 * wrote, so the directory's other workspaces read that kind too, to skip it when sending. `crm` is
 * who a linked CRM says is a customer or an open deal: nobody prospects them, though a member can
 * still answer someone already in conversation. It can also hold a whole company (`domain/crm-exclusions.ts`).
 */
export const suppression = pgTable(
  "suppression",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceColumn(),
    /** A lowercased address (ada@acme.fr) or domain (acme.fr). */
    value: text().notNull(),
    reason: suppressionReason().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique().on(table.workspaceId, table.value),
    tenantIsolation(),
    pgPolicy("directory_bounces", { for: "select", to: appRole, using: sql`${table.reason} = 'bounced' and ${table.workspaceId} in (select id from workspace where directory_id = ${currentDirectory})` }),
  ],
).enableRLS();

/**
 * The company, person and contact detail rows a migration merged, each as it was, and the fields of
 * those it kept. That's a record to read, not a way back: it doesn't say what pointed at which row, or
 * what else the migration changed. Undoing one means a restore point taken before it. The trusted path
 * only: the app role has no grant on it.
 */
export const directoryMerge = pgTable("directory_merge", {
  id: uuid().primaryKey().defaultRandom(),
  /** company, person or contact_detail. */
  kind: text().notNull(),
  /** The row, and the one that took its place: the same id for a row that stayed, with its fields from before. */
  rowId: uuid().notNull(),
  keptId: uuid().notNull(),
  row: jsonb().notNull(),
  mergedAt: createdAt(),
}).enableRLS();
