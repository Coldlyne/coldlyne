import type { Adapter } from "../adapter";
import { calcom } from "./calcom";
import { calendly } from "./calendly";
import { googleCalendar } from "./google";
import { microsoftCalendar } from "./microsoft";

/** The calendars connectors, by kind. */
export const calendarsAdapters: Record<string, Adapter> = {
  google_calendar: googleCalendar,
  microsoft_calendar: microsoftCalendar,
  calcom,
  calendly,
};
