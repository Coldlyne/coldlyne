import type { DomainReputation } from "@/application/ports";
import type { Adapter } from "../adapter";
import { checked } from "../checked";
import { bearerJson, requestJson } from "../http";
import { everyPage } from "../pages";

/**
 * Gmail's view of a domain, through Postmaster Tools API v2, generally available since February
 * 2026; Google says v1 will be retired, without a date yet.
 *
 * v2 has no domain reputation: Google is retiring that verdict along with its dashboard. So
 * `reputation` is always null here. It isn't inferred from the spam rate: the port promises Gmail's
 * own verdict, and a guess shown as one would mislead a member about their domain.
 *
 * Google only reports on domains sending to at least 50 users a day, and only the days with data.
 *
 * Docs:
 * - https://developers.google.com/workspace/gmail/postmaster/reference/rest/v2
 * - https://developers.google.com/workspace/gmail/postmaster/reference/rest/v2/domains.domainStats/query
 * - https://developers.google.com/workspace/gmail/postmaster/reference/rest/v2/domains/list
 * - https://developers.google.com/workspace/gmail/postmaster/reference/rest/v2/MetricDefinition
 * - https://developers.google.com/workspace/gmail/postmaster/guides/migration-v2
 * - https://support.google.com/mail/answer/16594218
 */

const PROVIDER = "Google Postmaster Tools";
const API = "https://gmailpostmastertools.googleapis.com/v2";
/** The most either list returns a page. */
const PAGE_SIZE = 200;
const SPAM_RATE = "spam_rate";
const DAY_MS = 24 * 60 * 60 * 1000;

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

interface DomainsPage {
  domains?: { name?: string; verificationState?: string }[];
  nextPageToken?: string;
}

interface DomainStat {
  metric?: string;
  date?: CalendarDate;
  value?: { doubleValue?: number; floatValue?: number; intValue?: string };
}

interface StatsPage {
  domainStats?: DomainStat[];
  nextPageToken?: string;
}

const utcDate = (at: Date): CalendarDate => ({ year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() });
const isoDate = ({ year, month, day }: CalendarDate) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

/** "1 domaine vérifié", "3 domaines vérifiés"; in French, zero takes the singular. */
const verifiedDomains = (count: number) => (count > 1 ? `${count} domaines vérifiés` : `${count} domaine vérifié`);

function spamRateOf({ value }: DomainStat): number | null {
  const rate = value?.doubleValue ?? value?.floatValue ?? (value?.intValue === undefined ? undefined : Number(value.intValue));
  return rate ?? null;
}

function reputationOf(stat: DomainStat): DomainReputation[] {
  return stat.date ? [{ date: isoDate(stat.date), reputation: null, spamRate: spamRateOf(stat) }] : [];
}

export const postmaster: Adapter = (context) => {
  const headers = async () => bearerJson(await context.accessToken());

  /** The days wanted, today included: the range's two ends are inclusive. */
  function lastDays(days: number) {
    const now = context.now();
    return { start: utcDate(new Date(now.getTime() - (Math.max(days, 1) - 1) * DAY_MS)), end: utcDate(now) };
  }

  return {
    check: () =>
      checked(PROVIDER, async () => {
        const pages = await everyPage(
          async (pageToken) => requestJson<DomainsPage>(context.fetch, PROVIDER, `${API}/domains?${new URLSearchParams({ pageSize: String(PAGE_SIZE), ...(pageToken ? { pageToken } : {}) })}`, { headers: await headers() }),
          (page) => page.nextPageToken,
        );
        const verified = pages.flatMap((page) => page.domains ?? []).filter((domain) => domain.verificationState === "VERIFIED").length;
        const label = verifiedDomains(verified);
        return { ok: true, detail: verified ? label : `${label} : ajoutez et vérifiez votre domaine d’envoi dans Postmaster Tools.`, label };
      }),

    async reputation(domain: string, days: number): Promise<DomainReputation[]> {
      const query = {
        metricDefinitions: [{ name: SPAM_RATE, baseMetric: { standardMetric: "SPAM_RATE" } }],
        timeQuery: { dateRanges: { dateRanges: [lastDays(days)] } },
        aggregationGranularity: "DAILY",
        pageSize: PAGE_SIZE,
      };
      const pages = await everyPage(
        async (pageToken) => requestJson<StatsPage>(context.fetch, PROVIDER, `${API}/domains/${encodeURIComponent(domain)}/domainStats:query`, { method: "POST", headers: await headers(), body: JSON.stringify({ ...query, ...(pageToken ? { pageToken } : {}) }) }),
        (page) => page.nextPageToken,
      );
      const stats = pages.flatMap((page) => page.domainStats ?? []).filter((stat) => stat.metric === SPAM_RATE);
      return stats.flatMap(reputationOf).sort((earlier, later) => earlier.date.localeCompare(later.date));
    },
  };
};
