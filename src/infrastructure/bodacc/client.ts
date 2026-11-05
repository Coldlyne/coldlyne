import { bodaccWhere, fromBodacc, type BodaccAnnouncement, type BodaccApiRecord, type BodaccQuery } from "@/domain/bodacc";
import { requestJson } from "@/infrastructure/connectors/http";

/**
 * Coldlyne's built-in source of events, open data needing no connection. The dataset:
 * https://bodacc-datadila.opendatasoft.com/explore/dataset/annonces-commerciales/api/
 * The Explore API v2.1 and its query language, ODSQL: https://help.opendatasoft.com/apis/ods-explore-v2/
 */
const API = "https://bodacc-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/annonces-commerciales/records";
const PROVIDER = "Le BODACC";
/** The API accepts up to 100 a page; 25 is what a conversation can read, as with the registry. */
export const BODACC_PAGE_SIZE = 25;
/** The API refuses to page past 10,000 records (offset + limit), whatever the total. */
const REACHABLE_RECORDS = 10_000;

export interface BodaccPage {
  announcements: BodaccAnnouncement[];
  /** How many match, reachable or not. */
  total: number;
  page: number;
  /** How many pages can be read: past 10,000 records, narrow the dates to see the rest. */
  pages: number;
}

/** Announcements matching the query, the latest first, a page at a time. */
export async function searchBodacc(query: BodaccQuery, fetchUrl: typeof fetch = fetch): Promise<BodaccPage> {
  const page = query.page ?? 1;
  const params = new URLSearchParams({
    where: bodaccWhere(query),
    // The id settles ties, as thousands of announcements share a date: pages must not overlap.
    order_by: "dateparution desc, id desc",
    limit: String(BODACC_PAGE_SIZE),
    offset: String((page - 1) * BODACC_PAGE_SIZE),
  });
  const body = await requestJson<{ total_count?: number; results?: BodaccApiRecord[] }>(fetchUrl, PROVIDER, `${API}?${params}`);
  const total = body.total_count ?? 0;
  return {
    announcements: (body.results ?? []).flatMap(fromBodacc),
    total,
    page,
    pages: Math.ceil(Math.min(total, REACHABLE_RECORDS) / BODACC_PAGE_SIZE),
  };
}
