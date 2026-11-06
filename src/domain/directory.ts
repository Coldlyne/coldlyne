/**
 * A directory (a group, on the screens and in the tools) is what a group of workspaces holds in common:
 * companies and the people at them, found once. Lists, sequences, messages and opt-outs stay each
 * workspace's own, so another workspace only ever learns the bare facts below, and decides for itself.
 */

/** What another workspace of the directory did with someone: never what it wrote. */
export interface ElsewhereNote {
  personId: string;
  person: string;
  workspace: string;
  /** The last time it wrote to them. */
  writtenAt: Date | null;
  /** When they asked that workspace not to contact them. It doesn't stop this one: a member decides. */
  optedOutAt: Date | null;
}

const day = new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeZone: "Europe/Paris" });

/** What the note says, for a sentence that has already said who. */
function elsewhereFacts({ workspace, writtenAt, optedOutAt }: Pick<ElsewhereNote, "workspace" | "writtenAt" | "optedOutAt">): string {
  const facts = [writtenAt && `a été contactée depuis ${workspace} le ${day.format(writtenAt)}`, optedOutAt && `a demandé à ${workspace} de ne plus la contacter le ${day.format(optedOutAt)}`];
  return facts.filter(Boolean).join(", et ");
}

/** The note in a member's words, about someone they already have in front of them. */
export const elsewhereInWords = (note: Pick<ElsewhereNote, "workspace" | "writtenAt" | "optedOutAt">) => `Cette personne ${elsewhereFacts(note)}.`;

/** The same, naming them, for a report on several. */
export const elsewhereWithName = (note: ElsewhereNote) => `${note.person}\u00a0: ${elsewhereFacts(note)}.`;

/** For this long, what the registry said of a company is good enough for another workspace not to ask again. */
const REGISTRY_FACTS_LAST_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * Whether the directory's word on a company can stand in for asking the registry. Never for ever: a
 * company can refuse commercial use of its data at any time, and that must end up being heard.
 */
export const registryFactsStillGood = (checkedAt: Date | null, now: Date) => checkedAt !== null && now.getTime() - checkedAt.getTime() < REGISTRY_FACTS_LAST_DAYS * DAY_MS;
