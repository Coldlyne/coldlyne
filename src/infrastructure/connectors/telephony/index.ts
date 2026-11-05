import type { Adapter } from "../adapter";
import { aircallAdapter } from "./aircall";
import { ringoverAdapter } from "./ringover";
import { twilioAdapter } from "./twilio";

/** The telephony connectors, by kind. */
export const telephonyAdapters: Record<string, Adapter> = {
  twilio: twilioAdapter,
  aircall: aircallAdapter,
  ringover: ringoverAdapter,
};
