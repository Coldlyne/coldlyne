/**
 * Whether a sending domain will be trusted: its SPF, DKIM, DMARC and MX, judged from DNS answers
 * someone else looked up, with advice in the member's words and the records that fix what can be
 * fixed. Pure: the lookups live in `infrastructure/dns/checks`.
 *
 * Docs:
 * - SPF, RFC 7208: https://datatracker.ietf.org/doc/html/rfc7208
 * - DMARC, RFC 7489: https://datatracker.ietf.org/doc/html/rfc7489
 * - Google: https://knowledge.workspace.google.com/admin/security/set-up-spf
 *   and https://knowledge.workspace.google.com/admin/security/set-up-dkim
 * - Microsoft: https://learn.microsoft.com/en-us/defender-office-365/email-authentication-spf-configure,
 *   https://learn.microsoft.com/en-us/defender-office-365/email-authentication-dkim-configure
 *   and https://learn.microsoft.com/en-us/defender-office-365/email-authentication-dmarc-configure
 * - OVHcloud: https://docs.ovhcloud.com/en/guides/web-cloud/domains/dns-zone-spf,
 *   https://docs.ovhcloud.com/en/guides/web-cloud/domains/dns-zone-dkim
 *   and https://docs.ovhcloud.com/en/guides/web-cloud/domains/dns-zone-dmarc
 * - Infomaniak: https://www.infomaniak.com/en/support/faq/2199/manage-spf-records
 *   and https://www.infomaniak.com/en/support/faq/1775/link-an-infomaniak-mail-service-to-an-external-service
 */

export type MailboxProvider = "google" | "microsoft" | "ovh" | "infomaniak";

/** A record to publish, shaped like the DnsManager port's: the domain layer can't import that port. */
export interface DnsRecord {
  type: "TXT" | "CNAME" | "MX";
  /** Relative to the domain: "@" for the apex, "_dmarc", "s1._domainkey". */
  name: string;
  value: string;
}

/** What one selector answers: Google publishes a TXT key, Microsoft and OVHcloud a CNAME. */
export interface DkimAnswer {
  selector: string;
  txt: string[];
  cname: string[];
}

/** What DNS says about a domain, as `infrastructure/dns/checks` gathers it. */
export interface DnsAnswers {
  /** The TXT records at the domain itself, each joined from its chunks. */
  apexTxt: string[];
  /**
   * The SPF record of each domain an include or redirect reaches; null when it publishes none.
   * A Map, since these names are whatever someone's DNS says: "constructor" included.
   */
  spfTree: ReadonlyMap<string, string | null>;
  /** The TXT records at _dmarc, the nearest parent's when the domain has none: subdomains inherit it. */
  dmarcTxt: string[];
  dkim: DkimAnswer[];
  mx: { exchange: string; priority: number }[];
}

export interface ReportPart {
  ok: boolean;
  /** The records as published. */
  found: string[];
  /** What to do, in French. A part can be ok and still have advice: p=none works, and is only a start. */
  advice: string[];
}

export interface DeliverabilityReport {
  spf: ReportPart;
  dkim: ReportPart;
  dmarc: ReportPart;
  mx: ReportPart;
}

interface MailboxRules {
  name: string;
  spfInclude: string;
  /** The closing term this provider's own documentation gives. */
  spfAll: "~all" | "-all";
  /** Selectors that are the same for every customer; empty when each service has its own. */
  dkimSelectors: readonly string[];
  /** Where the key or the CNAME targets come from: none of them can be known from here. */
  dkimSetup: string;
}

const MAILBOXES: Record<MailboxProvider, MailboxRules> = {
  google: {
    name: "Google Workspace",
    spfInclude: "_spf.google.com",
    spfAll: "~all",
    dkimSelectors: ["google"],
    dkimSetup: "Générez la clé dans la console d’administration (Applications, Google Workspace, Gmail, Authentifier les e-mails), puis publiez-la en TXT sur google._domainkey.",
  },
  microsoft: {
    name: "Microsoft 365",
    spfInclude: "spf.protection.outlook.com",
    spfAll: "-all",
    dkimSelectors: ["selector1", "selector2"],
    dkimSetup: "Publiez les deux CNAME selector1._domainkey et selector2._domainkey : leurs cibles sont propres à votre organisation et s’affichent dans le portail Microsoft Defender, onglet DKIM.",
  },
  ovh: {
    name: "OVHcloud",
    spfInclude: "mx.ovh.com",
    spfAll: "~all",
    dkimSelectors: [],
    dkimSetup: "Le sélecteur est propre à votre service OVHcloud (ovhmo1234567-selector1, par exemple) : il s’affiche avec les CNAME à publier dans la fenêtre d’activation du badge DKIM de l’espace client.",
  },
  infomaniak: {
    name: "Infomaniak",
    spfInclude: "spf.infomaniak.ch",
    spfAll: "-all",
    dkimSelectors: [],
    dkimSetup: "Infomaniak génère l’enregistrement DKIM (CNAME ou TXT) et son sélecteur dans son Manager : copiez-les depuis votre service mail.",
  },
};

/** Past this, receivers fail SPF with a permerror (RFC 7208, section 4.6.4). */
export const SPF_LOOKUP_LIMIT = 10;

/** Why the assistant suggests a domain of its own for prospecting (product rule "Sending reputation"). */
export const SENDING_DOMAIN_ADVICE =
  "Prospectez depuis un domaine d’envoi séparé, pas depuis le domaine principal de l’entreprise : une mauvaise réputation n’y touchera ni vos factures ni vos échanges avec vos clients. Commencez son DMARC en p=none, puis passez à p=quarantine quand les rapports sont propres.";

// ─── Names ─────────────────────────────────────────────────────────────────

/** A hostname in the form DNS compares: lowercased, without the root's trailing dot. */
export const hostnameOf = (name: string) => name.trim().toLowerCase().replace(/\.$/, "");

/** Whether this reads as a domain to look up: labels and a final one of letters, as a member might type it. */
export const isDomainName = (name: string) => /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostnameOf(name));

/** The domain and each parent, down to two labels: where a subdomain's zone or inherited DMARC may be. */
export function domainAndParents(domain: string): string[] {
  const labels = hostnameOf(domain).split(".");
  const names: string[] = [];
  for (let start = 0; start <= Math.max(labels.length - 2, 0); start++) names.push(labels.slice(start).join("."));
  return names;
}

/** Whether a record in the zone is the one `wanted` replaces, so an upsert never duplicates it. */
export function sameRecord(existing: DnsRecord, wanted: DnsRecord): boolean {
  if (existing.type !== wanted.type || relativeNameKey(existing.name) !== relativeNameKey(wanted.name)) return false;
  if (wanted.type === "CNAME") return true;
  if (wanted.type === "MX") return mxHost(existing.value) === mxHost(wanted.value);
  return txtKind(existing.value) === txtKind(wanted.value);
}

const relativeNameKey = (name: string) => hostnameOf(name) || "@";

/** "10 mx1.mail.ovh.net." → "mx1.mail.ovh.net": a domain lists several MX, each its own record. */
const mxHost = (value: string) => hostnameOf(value.trim().split(/\s+/).at(-1) ?? "");

/**
 * What a TXT record is for. The apex holds several (SPF, a site's verification…): replacing "the
 * TXT at @" would delete those, so only one of the same kind counts as the same record.
 */
function txtKind(value: string): string {
  const tag = /^v=([a-z0-9]+)/i.exec(value.trim());
  return tag ? tag[1].toLowerCase() : value.trim();
}

// ─── SPF ───────────────────────────────────────────────────────────────────

export interface Spf {
  /** The DNS lookups this record itself costs: include, a, mx, ptr, exists and redirect. */
  lookups: number;
  includes: string[];
  redirect: string | null;
  /** The closing term as written ("~all", "-all", "?all", "+all", "all"), null without one. */
  all: string | null;
}

export const spfRecordsIn = (txt: readonly string[]) => txt.map((record) => record.trim()).filter((record) => /^v=spf1(\s|$)/i.test(record));

export function parseSpf(record: string): Spf {
  const spf: Spf = { lookups: 0, includes: [], redirect: null, all: null };
  for (const term of record.trim().split(/\s+/).slice(1)) readSpfTerm(term, spf);
  return spf;
}

function readSpfTerm(term: string, spf: Spf): void {
  const bare = term.replace(/^[-+~?]/, "").toLowerCase();
  if (bare === "all") {
    spf.all = term.toLowerCase();
  } else if (bare.startsWith("include:")) {
    spf.includes.push(hostnameOf(bare.slice("include:".length)));
    spf.lookups++;
  } else if (bare.startsWith("redirect=")) {
    spf.redirect = hostnameOf(bare.slice("redirect=".length));
    spf.lookups++;
  } else if (/^(a|mx|ptr|exists)([:/]|$)/.test(bare)) {
    spf.lookups++;
  }
}

/** The domains a record sends a receiver to. A macro (%{i}) depends on the sender, so can't be followed. */
export function spfTargets(record: string): string[] {
  const { includes, redirect } = parseSpf(record);
  return [...includes, ...(redirect ? [redirect] : [])].filter((target) => !target.includes("%"));
}

interface SpfWalk {
  lookups: number;
  reached: string[];
  /** Includes that publish no SPF: a permerror for whoever follows them. */
  broken: string[];
}

function walkSpf(record: string, tree: DnsAnswers["spfTree"]): SpfWalk {
  const walk: SpfWalk = { lookups: 0, reached: [], broken: [] };
  followSpf(record, tree, [], walk);
  return walk;
}

function followSpf(record: string, tree: DnsAnswers["spfTree"], path: string[], walk: SpfWalk): void {
  // Past the limit the verdict is known, and a looping or enormous tree can't make this run long.
  if (walk.lookups > SPF_LOOKUP_LIMIT) return;
  walk.lookups += parseSpf(record).lookups;
  for (const target of spfTargets(record)) {
    walk.reached.push(target);
    if (path.includes(target)) continue;
    const nested = tree.get(target);
    if (nested) followSpf(nested, tree, [...path, target], walk);
    else if (nested === null) walk.broken.push(target);
  }
}

function spfProblems(record: string, tree: DnsAnswers["spfTree"], rules: MailboxRules): string[] {
  const walk = walkSpf(record, tree);
  const { all, redirect } = parseSpf(record);
  const problems: string[] = [];
  if (!walk.reached.includes(rules.spfInclude)) problems.push(`Le SPF n’autorise pas ${rules.name} : ajoutez include:${rules.spfInclude}.`);
  if (walk.lookups > SPF_LOOKUP_LIMIT) problems.push(`Le SPF demande plus de ${SPF_LOOKUP_LIMIT} recherches DNS : les serveurs le refusent. Retirez des include, ou passez les services tiers sur un sous-domaine.`);
  for (const target of walk.broken) problems.push(`include:${target} ne publie aucun SPF : les serveurs refusent tout l’enregistrement. Corrigez-le ou retirez-le.`);
  if (all === "+all" || all === "all") problems.push(`« ${all} » autorise n’importe qui à écrire en votre nom : remplacez-le par ${rules.spfAll}.`);
  if (!all && !redirect) problems.push(`Le SPF ne se termine pas par « all » : ajoutez ${rules.spfAll}.`);
  return problems;
}

function spfPart(answers: DnsAnswers, rules: MailboxRules): ReportPart {
  const records = spfRecordsIn(answers.apexTxt);
  if (!records.length) return { ok: false, found: [], advice: [`Aucun enregistrement SPF : les serveurs ne savent pas qui peut écrire pour ce domaine. Ajoutez « ${newSpf(rules)} ».`] };
  if (records.length > 1) return { ok: false, found: records, advice: ["Plusieurs enregistrements SPF : les serveurs les refusent tous. Fusionnez-les en un seul."] };
  const problems = spfProblems(records[0], answers.spfTree, rules);
  const notes = parseSpf(records[0]).all === "?all" ? [`« ?all » ne protège de rien : préférez ${rules.spfAll}.`] : [];
  return { ok: problems.length === 0, found: records, advice: [...problems, ...notes] };
}

const newSpf = (rules: MailboxRules) => `v=spf1 include:${rules.spfInclude} ${rules.spfAll}`;

/** The record corrected: the provider authorized, and a closing term that protects. */
function correctedSpf(record: string, tree: DnsAnswers["spfTree"], rules: MailboxRules): string {
  const walk = walkSpf(record, tree);
  const [version, ...terms] = record.trim().split(/\s+/);
  const closed = terms.map((term) => (["+all", "all"].includes(term.toLowerCase()) ? rules.spfAll : term));
  const { all, redirect } = parseSpf(record);
  return [version, ...(walk.reached.includes(rules.spfInclude) ? [] : [`include:${rules.spfInclude}`]), ...closed, ...(all || redirect ? [] : [rules.spfAll])].join(" ");
}

function spfFixes(answers: DnsAnswers, rules: MailboxRules): DnsRecord[] {
  const records = spfRecordsIn(answers.apexTxt);
  if (!records.length) return [{ type: "TXT", name: "@", value: newSpf(rules) }];
  // Several records need merging and an overweight one needs choices: both are the member's call.
  if (records.length > 1 || walkSpf(records[0], answers.spfTree).lookups > SPF_LOOKUP_LIMIT) return [];
  const corrected = correctedSpf(records[0], answers.spfTree, rules);
  return corrected === records[0] ? [] : [{ type: "TXT", name: "@", value: corrected }];
}

// ─── DMARC ─────────────────────────────────────────────────────────────────

export interface Dmarc {
  /** none, quarantine or reject; null when the record has none. */
  policy: string | null;
  /** Where aggregate reports go, as mailto: addresses. */
  rua: string[];
  /** The share of failing mail the policy applies to; 100 unless it says otherwise. */
  pct: number;
}

const VALID_POLICIES = ["none", "quarantine", "reject"];

export const dmarcRecordsIn = (txt: readonly string[]) => txt.map((record) => record.trim()).filter((record) => /^v=dmarc1\s*(;|$)/i.test(record));

export function parseDmarc(record: string): Dmarc {
  const tags = new Map(record.split(";").flatMap(tagOf));
  const pct = Number(tags.get("pct") ?? 100);
  return {
    policy: tags.get("p")?.toLowerCase() ?? null,
    rua: (tags.get("rua") ?? "").split(",").map((address) => address.trim()).filter(Boolean),
    pct: Number.isFinite(pct) ? pct : 100,
  };
}

function tagOf(tag: string): [string, string][] {
  const equals = tag.indexOf("=");
  return equals < 0 ? [] : [[tag.slice(0, equals).trim().toLowerCase(), tag.slice(equals + 1).trim()]];
}

const newDmarc = (reports?: string) => `v=DMARC1; p=none${reports ? `; rua=mailto:${reports}` : ""}`;

function dmarcAdvice({ policy, rua, pct }: Dmarc): string[] {
  const advice: string[] = [];
  if (policy === "none") advice.push("p=none ne protège pas encore, et c’est le bon début : passez à p=quarantine quand les rapports sont propres.");
  else if (pct < 100) advice.push(`pct=${pct} n’applique la politique qu’à ${pct} % des messages qui échouent : montez à 100 quand les rapports sont propres.`);
  if (!rua.length) advice.push("Aucune adresse rua : vous ne recevrez aucun rapport. Ajoutez rua=mailto:rapports@votre-domaine, avec une boîte réservée à ces rapports.");
  return advice;
}

function dmarcPart(answers: DnsAnswers): ReportPart {
  const records = dmarcRecordsIn(answers.dmarcTxt);
  if (!records.length) return { ok: false, found: [], advice: [`Aucun enregistrement DMARC : ajoutez « ${newDmarc()} » sur _dmarc, pour lire les rapports sans risquer vos envois.`] };
  if (records.length > 1) return { ok: false, found: records, advice: ["Plusieurs enregistrements DMARC : les serveurs les ignorent tous. Gardez-en un seul."] };
  const dmarc = parseDmarc(records[0]);
  if (!VALID_POLICIES.includes(dmarc.policy ?? "")) return { ok: false, found: records, advice: ["Le DMARC n’a pas de politique valable : indiquez p=none pour commencer."] };
  return { ok: true, found: records, advice: dmarcAdvice(dmarc) };
}

function dmarcFixes(answers: DnsAnswers, reports?: string): DnsRecord[] {
  const records = dmarcRecordsIn(answers.dmarcTxt);
  if (records.length > 1) return [];
  if (records.length === 1 && VALID_POLICIES.includes(parseDmarc(records[0]).policy ?? "")) return [];
  return [{ type: "TXT", name: "_dmarc", value: newDmarc(reports) }];
}

// ─── DKIM ──────────────────────────────────────────────────────────────────

/** The selectors to look up: the ones the member gave, or the provider's when every customer has the same. */
export function dkimSelectorsOf(provider: MailboxProvider, given: readonly string[] = []): string[] {
  const named = given.map((selector) => hostnameOf(selector).replace(/\._domainkey.*$/, "")).filter(Boolean);
  return named.length ? named : [...MAILBOXES[provider].dkimSelectors];
}

/** A CNAME to the provider's key, or a TXT whose key isn't empty: an empty p= means a revoked key. */
const isPublished = ({ txt, cname }: DkimAnswer) => cname.length > 0 || txt.some((record) => /(^|;)\s*p=[^;\s]/i.test(record));

const dkimFound = ({ selector, txt, cname }: DkimAnswer) => [...cname, ...txt].map((value) => `${selector}._domainkey → ${value}`);

function dkimPart(answers: DnsAnswers, rules: MailboxRules): ReportPart {
  if (!answers.dkim.length) return { ok: false, found: [], advice: [`Coldlyne ne peut pas vérifier DKIM sans son sélecteur, ce qui ne veut pas dire qu’il manque. ${rules.dkimSetup}`] };
  const missing = answers.dkim.filter((answer) => !isPublished(answer)).map(({ selector }) => `${selector}._domainkey`);
  const found = answers.dkim.flatMap(dkimFound);
  return missing.length ? { ok: false, found, advice: [`DKIM absent ou révoqué sur ${missing.join(" et ")}. ${rules.dkimSetup}`] } : { ok: true, found, advice: [] };
}

// ─── MX ────────────────────────────────────────────────────────────────────

function mxPart(answers: DnsAnswers, rules: MailboxRules): ReportPart {
  // A null MX (RFC 7505) has an empty exchange: it says the domain takes no mail at all.
  const found = answers.mx.filter(({ exchange }) => hostnameOf(exchange)).map(({ exchange, priority }) => `${priority} ${hostnameOf(exchange)}`);
  if (found.length) return { ok: true, found, advice: [] };
  return { ok: false, found, advice: [`Aucun MX : les réponses et les erreurs d’envoi se perdent, et les serveurs se méfient d’un domaine qui ne reçoit rien. Ajoutez ceux que ${rules.name} indique.`] };
}

// ─── The report ────────────────────────────────────────────────────────────

export function deliverabilityReport(answers: DnsAnswers, provider: MailboxProvider): DeliverabilityReport {
  const rules = MAILBOXES[provider];
  return { spf: spfPart(answers, rules), dkim: dkimPart(answers, rules), dmarc: dmarcPart(answers), mx: mxPart(answers, rules) };
}

/**
 * The records a DnsManager can apply for this provider. Only what can be known: SPF and DMARC.
 * DKIM keys and CNAME targets come from the provider's console, and the port's upsert can't set a
 * domain's several MX, so those two stay as advice.
 */
export function recordsToFix(answers: DnsAnswers, provider: MailboxProvider, options: { dmarcReports?: string } = {}): DnsRecord[] {
  return [...spfFixes(answers, MAILBOXES[provider]), ...dmarcFixes(answers, options.dmarcReports)];
}
