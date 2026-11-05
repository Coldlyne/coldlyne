/** A text as people mean it, whatever its capitals and accents: "Société" and "SOCIETE" are one word. */
export const plainLowercase = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
