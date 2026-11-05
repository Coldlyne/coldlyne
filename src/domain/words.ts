/** A text as people mean it, whatever its capitals and accents: "Société" and "SOCIETE" are one word. */
export const plainLowercase = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

/** Names in a French sentence: "A, B et C". */
export function listInFrench(names: string[]): string {
  const head = names.slice(0, -1).join(", ");
  return head ? `${head} et ${names.at(-1)}` : (names[0] ?? "");
}
