import { expect } from "vitest";

/** French typography for a user-facing sentence: narrow no-break space before ? ! ;, no-break space before : and inside « », typographic apostrophe. */
export function expectFrenchTypography(text: string) {
  expect(text).not.toContain("'");
  expect(text).not.toMatch(/[^ ]:(\s|$)/);
  expect(text).not.toMatch(/[^\S\u202f][;?!](\s|$)/);
  expect(text).not.toMatch(/[^ ][?!](\s|$)/);
  expect(text).not.toMatch(/«[^ ]|[^ ]»/);
}
