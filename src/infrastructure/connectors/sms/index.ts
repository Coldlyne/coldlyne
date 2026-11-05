import type { Adapter } from "../adapter";
import { brevoSms } from "./brevo";
import { ovhSms } from "./ovh-sms";
import { smsmode } from "./smsmode";

/** The sms connectors, by kind. */
export const smsAdapters: Record<string, Adapter> = {
  brevo_sms: brevoSms,
  ovh_sms: ovhSms,
  smsmode,
};
