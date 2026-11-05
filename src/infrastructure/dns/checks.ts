import dns from "node:dns/promises";
import {
  deliverabilityReport,
  dkimSelectorsOf,
  dmarcRecordsIn,
  domainAndParents,
  hostnameOf,
  recordsToFix,
  SENDING_DOMAIN_ADVICE,
  spfRecordsIn,
  spfTargets,
  type DeliverabilityReport,
  type DkimAnswer,
  type DnsAnswers,
  type DnsRecord,
  type MailboxProvider,
} from "@/domain/deliverability";

/**
 * A sending domain's SPF, DKIM, DMARC and MX, read from public DNS: built in, no connection needed.
 * The verdicts are the domain layer's; this file only asks the questions.
 *
 * Docs: https://nodejs.org/api/dns.html#dnspromisesresolvetxthostname
 */

export type DnsResolver = Pick<typeof dns, "resolveTxt" | "resolveMx" | "resolveCname">;

export interface DomainCheckOptions {
  resolver?: DnsResolver;
  /** Selectors the member copied from their provider: OVHcloud and Infomaniak have no common one. */
  dkimSelectors?: string[];
  /** The mailbox for DMARC's reports, when the member has one. */
  dmarcReports?: string;
}

export interface SendingDomainCheck {
  report: DeliverabilityReport;
  /** What a DnsManager can publish right away. */
  fixes: DnsRecord[];
  recommendation: string;
}

/** Enough for any real SPF tree, and a stop for one that tries to make the check run forever. */
const MAX_SPF_DOMAINS = 40;

/** "No such record" is an answer. A timeout isn't, and must not read as a missing SPF. */
const NO_ANSWER = new Set(["ENODATA", "ENOTFOUND"]);

async function answerOrNone<T>(lookup: () => Promise<T[]>): Promise<T[]> {
  try {
    return await lookup();
  } catch (error) {
    if (NO_ANSWER.has((error as NodeJS.ErrnoException).code ?? "")) return [];
    throw error;
  }
}

/** TXT records come in chunks of 255 bytes at most: a record is its chunks joined. */
const txtAt = async (name: string, resolver: DnsResolver) => (await answerOrNone(() => resolver.resolveTxt(name))).map((chunks) => chunks.join(""));

/** The SPF of every domain the record leads to, breadth first. */
async function spfTreeFrom(apexTxt: string[], resolver: DnsResolver): Promise<DnsAnswers["spfTree"]> {
  const tree = new Map<string, string | null>();
  let pending = spfRecordsIn(apexTxt).flatMap(spfTargets);
  while (pending.length && tree.size < MAX_SPF_DOMAINS) {
    const fresh = [...new Set(pending)].filter((target) => !tree.has(target));
    const records = await Promise.all(fresh.map(async (target) => spfRecordsIn(await txtAt(target, resolver))[0] ?? null));
    fresh.forEach((target, index) => tree.set(target, records[index]));
    pending = records.flatMap((record) => (record ? spfTargets(record) : []));
  }
  return tree;
}

/** The domain's DMARC, or the nearest parent's: a subdomain without one inherits it. */
async function dmarcTxtFor(domain: string, resolver: DnsResolver): Promise<string[]> {
  for (const name of domainAndParents(domain)) {
    const txt = await txtAt(`_dmarc.${name}`, resolver);
    if (dmarcRecordsIn(txt).length) return txt;
  }
  return [];
}

async function dkimAnswer(selector: string, domain: string, resolver: DnsResolver): Promise<DkimAnswer> {
  const name = `${selector}._domainkey.${domain}`;
  const [txt, cname] = await Promise.all([txtAt(name, resolver), answerOrNone(() => resolver.resolveCname(name))]);
  return { selector, txt, cname };
}

/** Everything DNS says about a sending domain, for the domain layer to judge. */
export async function lookUpDomain(domain: string, provider: MailboxProvider, options: DomainCheckOptions = {}): Promise<DnsAnswers> {
  const resolver = options.resolver ?? dns;
  const name = hostnameOf(domain);
  const selectors = dkimSelectorsOf(provider, options.dkimSelectors);
  const [apexTxt, dmarcTxt, dkim, mx] = await Promise.all([
    txtAt(name, resolver),
    dmarcTxtFor(name, resolver),
    Promise.all(selectors.map((selector) => dkimAnswer(selector, name, resolver))),
    answerOrNone(() => resolver.resolveMx(name)),
  ]);
  return { apexTxt, spfTree: await spfTreeFrom(apexTxt, resolver), dmarcTxt, dkim, mx };
}

/** The report on a sending domain, what can be published to fix it, and the standing advice. */
export async function checkSendingDomain(domain: string, provider: MailboxProvider, options: DomainCheckOptions = {}): Promise<SendingDomainCheck> {
  const answers = await lookUpDomain(domain, provider, options);
  return {
    report: deliverabilityReport(answers, provider),
    fixes: recordsToFix(answers, provider, { dmarcReports: options.dmarcReports }),
    recommendation: SENDING_DOMAIN_ADVICE,
  };
}
