import { describe, expect, it } from "vitest";
import { contactKindOf, dailyAllowance, DEFAULT_WINDOW, dueAfter, emailFooter, isSuppressed, letterFooter, mailboxProblem, minutesLeftInWindow, nextStep, renderTemplate, sendsThisTick, sentByColdlyne, smsText, windowProblem, withinWindow, type StepCondition } from "@/domain/sequences";
import { expectFrenchTypography } from "./support/french";

const step = (position: number, condition: StepCondition = "always") => ({ position, condition });

describe("the next step", () => {
  it("follows the order, whatever order they come in", () => {
    expect(nextStep([step(2), step(0), step(1)], -1, null)?.position).toBe(0);
    expect(nextStep([step(2), step(0), step(1)], 0, "done")?.position).toBe(1);
  });

  it("is none once the last has run", () => {
    expect(nextStep([step(0)], 0, "done")).toBeNull();
    expect(nextStep([], -1, null)).toBeNull();
  });

  it("leaves a gap where a step was removed", () => {
    expect(nextStep([step(0), step(3)], 0, "done")?.position).toBe(3);
  });

  it("can depend on how a call ended", () => {
    const steps = [step(0), step(1, "answered"), step(2, "no_answer"), step(3)];
    expect(nextStep(steps, 0, "answered")?.position).toBe(1);
    expect(nextStep(steps, 0, "no_answer")?.position).toBe(2);
    expect(nextStep(steps, 0, "voicemail_left")?.position).toBe(2);
    expect(nextStep(steps, 0, "done")?.position).toBe(3);
  });

  it("after a bounce, only runs a step written for it", () => {
    expect(nextStep([step(0), step(1), step(2, "bounced")], 0, "bounced")?.position).toBe(2);
    expect(nextStep([step(0), step(1)], 0, "bounced")).toBeNull();
    expect(nextStep([step(0), step(1, "bounced"), step(2)], -1, null)?.position).toBe(0);
    expect(nextStep([step(0), step(1, "bounced"), step(2)], 0, "done")?.position).toBe(2);
  });
});

describe("the channels", () => {
  it("sends email, SMS and letters itself, WhatsApp only to someone who agreed, and never the rest", () => {
    expect(["email", "sms", "letter"].every((channel) => sentByColdlyne(channel as "email"))).toBe(true);
    expect(sentByColdlyne("whatsapp")).toBe(false);
    expect(sentByColdlyne("whatsapp", true)).toBe(true);
    expect(["call", "voicemail", "linkedin", "instagram", "messenger", "x"].some((channel) => sentByColdlyne(channel as "call", true))).toBe(false);
  });

  it("knows where each channel's address is", () => {
    expect(["email", "sms", "call", "voicemail", "whatsapp", "messenger", "linkedin", "letter"].map((channel) => contactKindOf(channel as "email"))).toEqual(["email", "phone", "phone", "phone", "phone", "facebook", "linkedin", null]);
  });
});

describe("the window", () => {
  // 2026-11-09 is a Monday; Paris is an hour ahead of UTC then.
  const monday = (time: string) => new Date(`2026-11-09T${time}:00Z`);

  it("is open in office hours, in the sender's time zone", () => {
    expect(withinWindow(monday("08:30"), DEFAULT_WINDOW)).toBe(true);
    expect(withinWindow(monday("07:30"), DEFAULT_WINDOW)).toBe(false);
    expect(withinWindow(monday("17:30"), DEFAULT_WINDOW)).toBe(false);
    expect(minutesLeftInWindow(monday("16:00"), DEFAULT_WINDOW)).toBe(60);
  });

  it("is closed at the weekend", () => {
    expect(withinWindow(new Date("2026-11-07T10:00:00Z"), DEFAULT_WINDOW)).toBe(false);
    expect(withinWindow(new Date("2026-11-07T10:00:00Z"), { ...DEFAULT_WINDOW, days: [6] })).toBe(true);
  });

  it("refuses one that could never send", () => {
    expect(windowProblem(DEFAULT_WINDOW)).toBeNull();
    expect(windowProblem({ ...DEFAULT_WINDOW, from: "18:00", to: "09:00" })).toContain("heures");
    expect(windowProblem({ ...DEFAULT_WINDOW, from: "25:00" })).toContain("heures");
    expect(windowProblem({ ...DEFAULT_WINDOW, days: [] })).toContain("jour");
    expect(windowProblem({ ...DEFAULT_WINDOW, days: [8] })).toContain("jour");
    expect(windowProblem({ ...DEFAULT_WINDOW, timezone: "Mars/Olympus" })).toContain("fuseau");
  });
});

describe("how much a mailbox may send", () => {
  const now = new Date("2026-11-30T09:00:00Z");
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

  it("starts low and climbs over weeks to the cap", () => {
    expect(dailyAllowance(null, now, 40)).toBe(10);
    expect(dailyAllowance(daysAgo(2), now, 40)).toBe(10);
    expect(dailyAllowance(daysAgo(3), now, 40)).toBe(15);
    expect(dailyAllowance(daysAgo(9), now, 40)).toBe(25);
    expect(dailyAllowance(daysAgo(100), now, 40)).toBe(40);
  });

  it("never goes past a low cap", () => {
    expect(dailyAllowance(null, now, 5)).toBe(5);
    expect(dailyAllowance(daysAgo(100), now, 12)).toBe(12);
  });

  it("spreads what's left over what's left of the window, a few at a time", () => {
    expect(sendsThisTick(10, 540)).toBe(1);
    expect(sendsThisTick(36, 540)).toBe(1);
    expect(sendsThisTick(40, 150)).toBe(3);
    expect(sendsThisTick(5, 15)).toBe(3);
    expect(sendsThisTick(0, 100)).toBe(0);
    expect(sendsThisTick(10, 0)).toBe(0);
  });
});

describe("when a mailbox should stop", () => {
  it("says nothing on too few sends", () => {
    expect(mailboxProblem({ sent: 19, bounced: 10, optedOut: 10 })).toBeNull();
  });

  it("stops on too many bounces or opt-outs, and says why", () => {
    expect(mailboxProblem({ sent: 100, bounced: 4, optedOut: 9 })).toBeNull();
    const bounces = mailboxProblem({ sent: 100, bounced: 5, optedOut: 0 }) as string;
    expect(bounces).toContain("5 sur 100");
    expectFrenchTypography(bounces);
    expect(mailboxProblem({ sent: 100, bounced: 0, optedOut: 10 })).toContain("désinscriptions");
  });
});

describe("a message's words", () => {
  it("fills in its fields, and says which it lacks rather than leave a hole", () => {
    expect(renderTemplate("Bonjour {{firstName}}, {{ company }}", { firstName: "Ada", company: "Acme" })).toEqual({ text: "Bonjour Ada, Acme", missing: [] });
    expect(renderTemplate("Bonjour {{firstName}}", { firstName: "  " })).toEqual({ text: "Bonjour ", missing: ["firstName"] });
    expect(renderTemplate("{{nope}} {{nope}}", {})).toEqual({ text: " ", missing: ["nope"] });
  });

  it("takes a fallback", () => {
    expect(renderTemplate("Bonjour {{firstName|Madame, Monsieur}}", {})).toEqual({ text: "Bonjour Madame, Monsieur", missing: [] });
    expect(renderTemplate("Bonjour {{firstName|Madame}}", { firstName: "Ada" }).text).toBe("Bonjour Ada");
  });

  const sender = { name: "NORTHWIND", address: "1 rue de la Paix, 75002 Paris" };

  it("says who writes, why, where the data comes from and how to leave", () => {
    const footer = emailFooter(sender, { source: "registry", company: "ACME" }, "https://coldlyne.test/u/x");
    expect(footer).toContain("vous dirigez ACME");
    expect(footer).toContain("registre national des entreprises");
    expect(footer).toContain("NORTHWIND, 1 rue de la Paix");
    expect(footer).toContain("https://coldlyne.test/u/x");
    expectFrenchTypography(footer.replace("https://coldlyne.test/u/x", ""));
  });

  it("names the page an address came from, and doesn't claim a role it doesn't know", () => {
    const footer = emailFooter(sender, { source: "import", company: "ACME", page: "https://acme.fr/contact" }, "u");
    expect(footer).toContain("vous travaillez chez ACME");
    expect(footer).toContain("https://acme.fr/contact");
    expect(letterFooter(sender, { source: "registry", company: "ACME" }, "https://coldlyne.test/u/x")).toContain("écrivez à cette adresse");
  });

  it("names the sender in an SMS, once", () => {
    expect(smsText("NORTHWIND", "Bonjour")).toBe("NORTHWIND : Bonjour");
    expect(smsText("NORTHWIND", "Northwind vous écrit")).toBe("Northwind vous écrit");
  });
});

describe("the suppression list", () => {
  const suppressed = new Set(["ada@acme.fr", "blocked.fr", "+33612345678"]);

  it("covers an address, its whole domain, or a number", () => {
    expect(isSuppressed(" Ada@Acme.fr ", suppressed)).toBe(true);
    expect(isSuppressed("anyone@blocked.fr", suppressed)).toBe(true);
    expect(isSuppressed("+33612345678", suppressed)).toBe(true);
    expect(isSuppressed("other@acme.fr", suppressed)).toBe(false);
  });
});

describe("timing", () => {
  it("counts days from when the step before ended", () => {
    expect(dueAfter(new Date("2026-11-09T09:00:00Z"), 3)).toEqual(new Date("2026-11-12T09:00:00Z"));
  });
});
