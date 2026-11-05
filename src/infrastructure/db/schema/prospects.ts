import { boolean, index, integer, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, tenantIsolation, updatedAt, workspaceColumn } from "./shared";

// ─── Prospects ─────────────────────────────────────────────────────────────
//
// The companies a workspace prospects, the people at them, the lists it works through, and who
// it must never write to again. Each row says where it came from.

export const prospectSource = pgEnum("prospect_source", ["registry", "import", "member"]);

/** A company, as the French registry (or an import) describes it. */
export const company = pgTable(
  "company",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceColumn(),
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
    source: prospectSource().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [unique().on(table.workspaceId, table.siren), tenantIsolation()],
).enableRLS();

/** Someone at a company: from the registry, its directors (people, not companies). */
export const person = pgTable(
  "person",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceColumn(),
    companyId: uuid()
      .notNull()
      .references(() => company.id, { onDelete: "cascade" }),
    firstName: text(),
    lastName: text().notNull(),
    /** Their role there, in the registry's words: Président, Gérant… */
    role: text(),
    /** How many active companies they direct, when looked up: some offers are for those who run several. */
    companiesDirected: integer(),
    /** When they agreed to WhatsApp messages: the Business API only ever writes to people who did. */
    whatsappConsentAt: timestamp({ withTimezone: true }),
    source: prospectSource().notNull(),
    createdAt: createdAt(),
  },
  (table) => [unique().on(table.companyId, table.firstName, table.lastName), index().on(table.workspaceId), tenantIsolation()],
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
 * member confirmed it or brought it (a file they imported).
 */
export const contactDetail = pgTable(
  "contact_detail",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceColumn(),
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
  (table) => [unique().on(table.personId, table.kind, table.value), index().on(table.workspaceId), tenantIsolation()],
).enableRLS();

export const suppressionReason = pgEnum("suppression_reason", ["opted_out", "bounced", "asked", "member"]);

/** An address or a whole domain the workspace never writes to again, and why. */
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
  (table) => [unique().on(table.workspaceId, table.value), tenantIsolation()],
).enableRLS();
