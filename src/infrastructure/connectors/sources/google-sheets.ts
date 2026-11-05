import type { Adapter, AdapterContext } from "../adapter";
import { bearerJson, requestJson } from "../http";
import { checked } from "../checked";

/**
 * A member's own spreadsheet, read with the access they granted when signing in to Google.
 * Reading values: https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get
 * The spreadsheet's tabs: https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/sheets
 * Ranges without a tab's name mean the first visible one: https://developers.google.com/workspace/sheets/api/guides/concepts
 * Who signed in: https://accounts.google.com/.well-known/openid-configuration (`userinfo_endpoint`)
 */
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";
const PROVIDER = "Google";
const FIRST_TAB_FIELDS = "sheets.properties(hidden,gridProperties(rowCount,columnCount))";

interface Tab {
  properties?: { hidden?: boolean; gridProperties?: { rowCount?: number; columnCount?: number } };
}

/** Rows keyed by the header row. Google leaves out trailing empty cells, so a short row just has blanks. */
function rowsKeyedByHeader(values: readonly string[][]): Record<string, string>[] {
  const [headerRow = [], ...rows] = values;
  const headers = headerRow.map((header) => String(header).trim());
  return rows
    .filter((row) => row.some((cell) => String(cell).trim()))
    .map((row) => Object.fromEntries(headers.flatMap((header, column) => (header ? [[header, String(row[column] ?? "").trim()] as const] : []))));
}

const clientOf = ({ fetch: fetchUrl, accessToken }: AdapterContext) => async <T>(url: string) => requestJson<T>(fetchUrl, PROVIDER, url, { headers: bearerJson(await accessToken()) });

export const googleSheets: Adapter = (context) => {
  const get = clientOf(context);

  /**
   * The whole of the first visible tab, by its size rather than its name: a range without a tab's
   * name means that tab, and a French tab called "Liste d'Anna" raises no question of quoting.
   */
  const firstTabRange = async (spreadsheetId: string) => {
    const { sheets = [] } = await get<{ sheets?: Tab[] }>(`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent(FIRST_TAB_FIELDS)}`);
    const grid = sheets.find((tab) => !tab.properties?.hidden)?.properties?.gridProperties;
    return grid?.rowCount && grid.columnCount ? `R1C1:R${grid.rowCount}C${grid.columnCount}` : null;
  };

  return {
    check: () =>
      checked(PROVIDER, async () => {
        const { email } = await get<{ email?: string }>(USERINFO);
        return { ok: true, detail: email ? `Compte Google ${email}` : "Compte Google", label: email };
      }),

    rows: async (spreadsheetId, range) => {
      const read = range ?? (await firstTabRange(spreadsheetId));
      if (!read) return [];
      const { values = [] } = await get<{ values?: string[][] }>(`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(read)}`);
      return rowsKeyedByHeader(values);
    },
  };
};
