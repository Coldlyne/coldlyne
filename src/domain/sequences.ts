/**
 * The rules of a sequence, free of any database or provider: which step comes next, when sending is
 * allowed, how much a mailbox may send, when it should stop, and what a message says. They are the
 * same whoever acts, so no prompt can get around them.
 */

export const CHANNELS = ["email", "sms", "letter", "call", "voicemail", "linkedin", "whatsapp", "instagram", "messenger", "x"] as const;
export type Channel = (typeof CHANNELS)[number];

/** Sent by Coldlyne through an API. WhatsApp only joins them for someone who agreed: see {@link sentByColdlyne}. */
const API_CHANNELS: readonly Channel[] = ["email", "sms", "letter"];

/** Whether Coldlyne sends this itself, or prepares it for a member: platforms forbid the rest, and calls have a person on the line. */
export const sentByColdlyne = (channel: Channel, whatsappConsent = false) => API_CHANNELS.includes(channel) || (channel === "whatsapp" && whatsappConsent);

/** Where a channel's address comes from, among a person's contact details; a letter goes to the company's registered office. */
export function contactKindOf(channel: Channel): string | null {
  switch (channel) {
    case "email":
      return "email";
    case "sms":
    case "call":
    case "voicemail":
    case "whatsapp":
      return "phone";
    case "messenger":
      return "facebook";
    case "letter":
      return null;
    default:
      return channel;
  }
}

// ─── Which step comes next ─────────────────────────────────────────────────

export const STEP_CONDITIONS = ["always", "no_answer", "answered", "bounced"] as const;
export type StepCondition = (typeof STEP_CONDITIONS)[number];

/** How the last step ended, for the steps that depend on it. */
export type StepOutcome = "no_answer" | "answered" | "voicemail_left" | "bounced" | "done";

export interface StepRule {
  position: number;
  condition: StepCondition;
}

/**
 * Whether a step runs after this outcome. A reply stops everything before this is ever asked. A
 * bounce only leads to the steps written for it: the rest assumed the first message got there.
 */
function conditionMet(condition: StepCondition, outcome: StepOutcome | null): boolean {
  if (outcome === "bounced") return condition === "bounced";
  switch (condition) {
    case "always":
      return true;
    case "no_answer":
      return outcome === "no_answer" || outcome === "voicemail_left";
    case "answered":
      return outcome === "answered";
    default:
      return false;
  }
}

/** The step after this position that applies, or null when the sequence is over for this person. */
export function nextStep<T extends StepRule>(steps: readonly T[], lastPosition: number, outcome: StepOutcome | null): T | null {
  const ahead = steps.filter((step) => step.position > lastPosition).sort((a, b) => a.position - b.position);
  return ahead.find((step) => conditionMet(step.condition, outcome)) ?? null;
}

const DAY_MS = 86_400_000;

/** When a step falls due, counted from the moment the one before it ended. */
export const dueAfter = (from: Date, waitDays: number) => new Date(from.getTime() + waitDays * DAY_MS);

// ─── When sending is allowed ───────────────────────────────────────────────

export interface SendingWindow {
  /** ISO weekdays: 1 is Monday. */
  days: number[];
  /** Local hours, "09:00". */
  from: string;
  to: string;
  timezone: string;
}

export const DEFAULT_WINDOW: SendingWindow = { days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00", timezone: "Europe/Paris" };

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const minutesOf = (hour: string) => {
  const [hours, minutes] = hour.split(":").map(Number);
  return hours * 60 + minutes;
};

function localMoment(now: Date, timezone: string): { weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const part = (type: string) => parts.find((found) => found.type === type)?.value ?? "";
  return { weekday: WEEKDAYS.indexOf(part("weekday")) + 1, minutes: Number(part("hour")) * 60 + Number(part("minute")) };
}

/** How many minutes of the window are left now; zero outside it. */
export function minutesLeftInWindow(now: Date, window: SendingWindow): number {
  const { weekday, minutes } = localMoment(now, window.timezone);
  if (!window.days.includes(weekday) || minutes < minutesOf(window.from)) return 0;
  return Math.max(0, minutesOf(window.to) - minutes);
}

export const withinWindow = (now: Date, window: SendingWindow) => minutesLeftInWindow(now, window) > 0;

/** A window's problem in the member's words, or null: an impossible one would quietly never send. */
export function windowProblem(window: SendingWindow): string | null {
  const hour = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!hour.test(window.from) || !hour.test(window.to) || minutesOf(window.from) >= minutesOf(window.to)) return "Les heures d’envoi ne sont pas valables : indiquez par exemple 09:00 et 18:00.";
  if (window.days.length === 0 || window.days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) return "Choisissez au moins un jour d’envoi.";
  try {
    localMoment(new Date(0), window.timezone);
  } catch {
    return "Ce fuseau horaire n’existe pas.";
  }
  return null;
}

// ─── How much a mailbox may send ───────────────────────────────────────────

export const DEFAULT_DAILY_CAP = 40;
const RAMP_START = 10;
const RAMP_STEP = 5;
const RAMP_EVERY_DAYS = 3;

/** A mailbox's limit today: a new one starts low and climbs over weeks to the workspace's cap, however low that is. */
export function dailyAllowance(firstSentAt: Date | null, now: Date, cap: number): number {
  if (!firstSentAt) return Math.min(RAMP_START, cap);
  const days = Math.max(0, Math.floor((now.getTime() - firstSentAt.getTime()) / DAY_MS));
  return Math.min(cap, RAMP_START + RAMP_STEP * Math.floor(days / RAMP_EVERY_DAYS));
}

/** How often the scheduler runs, and the most one mailbox sends each time: a burst looks like what it is. */
export const TICK_MINUTES = 15;
const MAX_PER_TICK = 3;

/** How many this mailbox sends now, so what's left today spreads evenly over what's left of the window. */
export function sendsThisTick(leftToday: number, minutesLeft: number): number {
  if (leftToday <= 0 || minutesLeft <= 0) return 0;
  return Math.min(MAX_PER_TICK, Math.ceil(leftToday / Math.max(1, Math.ceil(minutesLeft / TICK_MINUTES))));
}

// ─── When a mailbox should stop ────────────────────────────────────────────

/** Too few sends say nothing: one bounce in five isn't a trend. */
const MIN_SENT_FOR_HEALTH = 20;
const MAX_BOUNCE_RATE = 0.05;
const MAX_OPT_OUT_RATE = 0.1;

export interface MailboxActivity {
  sent: number;
  bounced: number;
  optedOut: number;
}

/** Why a mailbox should stop sending before it hurts its domain, or null while it looks fine. */
export function mailboxProblem({ sent, bounced, optedOut }: MailboxActivity): string | null {
  if (sent < MIN_SENT_FOR_HEALTH) return null;
  if (bounced / sent >= MAX_BOUNCE_RATE) return `Trop d’adresses refusées : ${bounced} sur ${sent} envois en 7 jours. Vérifiez la liste avant de reprendre.`;
  if (optedOut / sent >= MAX_OPT_OUT_RATE) return `Trop de désinscriptions : ${optedOut} sur ${sent} envois en 7 jours. Revoyez le ciblage ou le message avant de reprendre.`;
  return null;
}

// ─── What a message says ───────────────────────────────────────────────────

export const MERGE_FIELDS = ["firstName", "lastName", "company", "role", "city", "sender"] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];
export type MergeValues = Partial<Record<MergeField, string | null>>;

/** Merge fields as `{{firstName}}`, with a fallback as `{{firstName|Bonjour}}`. */
const FIELD = /\{\{\s*([\p{L}\w]+)\s*(?:\|([^}]*))?\}\}/gu;

/** The text with its fields filled in, and those it lacks: a message is never sent with a hole in it. */
export function renderTemplate(template: string, values: MergeValues): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = template.replace(FIELD, (_, name: string, fallback?: string) => {
    const value = values[name as MergeField]?.trim();
    if (value) return value;
    if (fallback !== undefined) return fallback;
    missing.push(name);
    return "";
  });
  return { text, missing: [...new Set(missing)] };
}

/** What can be promised about someone's address, in a line. */
export interface DataOrigin {
  /** Where the person came from: the registry, or the sender's own file. */
  source: "registry" | "import" | "member";
  company: string;
  /** The page their address was found on, if it was found on one. */
  page?: string | null;
}

export interface SenderIdentity {
  name: string;
  address: string;
}

function whyThisPerson({ source, company, page }: DataOrigin): string {
  const reason = source === "registry" ? `vous dirigez ${company} (source : registre national des entreprises)` : `vous travaillez chez ${company}`;
  return page ? `${reason}. Votre adresse figure sur ${page}` : reason;
}

/** What the CNIL asks of every email: who writes, why this person, where the data comes from, and a simple way out. */
export function emailFooter(sender: SenderIdentity, origin: DataOrigin, unsubscribeUrl: string): string {
  return `--\nVous recevez ce message parce que ${whyThisPerson(origin)}.\nExpéditeur : ${sender.name}, ${sender.address}.\nPour ne plus recevoir de messages : ${unsubscribeUrl}`;
}

/** The same for a letter: an address to type, since a page can't be clicked. */
export function letterFooter(sender: SenderIdentity, origin: DataOrigin, unsubscribeUrl: string): string {
  return `Vous recevez ce courrier parce que ${whyThisPerson(origin)}. Expéditeur : ${sender.name}, ${sender.address}. Pour vous y opposer : ${unsubscribeUrl}, ou écrivez à cette adresse.`;
}

/** An SMS says who sends it; its provider adds the STOP, which French rules require it to run. */
export const smsText = (sender: string, body: string) => (body.toLowerCase().includes(sender.toLowerCase()) ? body : `${sender} : ${body}`);

export const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

/** Whether the suppression list covers this address, by itself or by its whole domain. */
export const isSuppressed = (address: string, suppressed: ReadonlySet<string>) => {
  const value = address.trim().toLowerCase();
  return suppressed.has(value) || (value.includes("@") && suppressed.has(domainOf(value)));
};

/** What a workspace can't write to, by why, since each does something different. */
export interface OffLimits {
  /** Its own list, but for bounces: someone asked, the workspace excluded them, or a linked CRM holds them. Any of a person's details on it stops them. */
  refused: ReadonlySet<string>;
  /** The same but for what a linked CRM says: who isn't answered either. A deal is someone a member can still write back to; a refusal isn't. */
  notAnswered: ReadonlySet<string>;
  /** Addresses that bounced for this workspace: a sequence goes on only through a step written for that. */
  bouncedHere: ReadonlySet<string>;
  /** Addresses that bounced for another workspace of its group: skipped, and the person isn't stopped. */
  bouncedElsewhere: ReadonlySet<string>;
}

export type AddressChoice<T> = { address: T; missing?: undefined } | { address?: undefined; missing: "none" | "bounced_here" | "bounced_elsewhere" };

/**
 * Which of someone's details to write to on a channel. Details come in the order to try them, this
 * workspace's own first; what it already wrote to comes before that, so a conversation keeps its
 * address. Nothing that bounced is used, whoever saw it bounce.
 */
export function addressToUse<T extends { kind: string; value: string }>(details: readonly T[], kind: string | null | undefined, used: readonly string[], offLimits: Pick<OffLimits, "bouncedHere" | "bouncedElsewhere">): AddressChoice<T> {
  const onChannel = details.filter((detail) => detail.kind === kind);
  const inOrder = [...used.flatMap((value) => onChannel.filter((detail) => detail.value === value)), ...onChannel];
  const working = inOrder.find(({ value }) => !isSuppressed(value, offLimits.bouncedHere) && !isSuppressed(value, offLimits.bouncedElsewhere));
  if (working) return { address: working };
  if (onChannel.some(({ value }) => isSuppressed(value, offLimits.bouncedHere))) return { missing: "bounced_here" };
  return { missing: onChannel.length ? "bounced_elsewhere" : "none" };
}

// ─── What a reply is ───────────────────────────────────────────────────────

export const INTERESTS = ["interested", "not_now", "not_interested", "wrong_person"] as const;
export type Interest = (typeof INTERESTS)[number];

export const INTEREST_NAMES: Record<Interest, string> = { interested: "Intéressé", not_now: "Pas maintenant", not_interested: "Pas intéressé", wrong_person: "Mauvais contact" };

// ─── What things are called ────────────────────────────────────────────────

export const CHANNEL_NAMES: Record<Channel, string> = { email: "Email", sms: "SMS", letter: "Courrier", call: "Appel", voicemail: "Message vocal", linkedin: "LinkedIn", whatsapp: "WhatsApp", instagram: "Instagram", messenger: "Messenger", x: "X" };

export const CONDITION_NAMES: Record<StepCondition, string> = { always: "Si pas de réponse", no_answer: "Si l’appel n’a pas abouti", answered: "Si l’appel a abouti", bounced: "Si l’adresse est refusée" };

export const SEQUENCE_STATUS_NAMES = { draft: "Brouillon", pending_approval: "À approuver", running: "En cours", paused: "En pause", finished: "Terminée" } as const;

export const STOP_REASON_NAMES: Record<string, string> = { replied: "A répondu", colleague_replied: "Un collègue a répondu", opted_out: "Désinscrit", bounced: "Adresse refusée", suppressed: "Liste d’exclusion", member: "Retiré" };
