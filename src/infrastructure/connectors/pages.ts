/** More than any real account has: a provider repeating its cursor must not hold a scheduled run forever. */
const MAX_PAGES = 500;

/** Reads page after page until the provider gives no next cursor, whatever it calls that cursor. */
export async function everyPage<Page>(read: (cursor: string | undefined) => Promise<Page>, nextCursor: (page: Page) => string | number | null | undefined): Promise<Page[]> {
  const pages: Page[] = [];
  let cursor: string | undefined;
  do {
    const page = await read(cursor);
    pages.push(page);
    const next = nextCursor(page);
    cursor = next ? String(next) : undefined;
  } while (cursor && pages.length < MAX_PAGES);
  return pages;
}
