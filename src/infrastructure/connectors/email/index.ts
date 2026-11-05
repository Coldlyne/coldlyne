import type { Adapter } from "../adapter";
import { gmailAdapter } from "./gmail";
import { microsoft365Adapter } from "./microsoft365";
import { smtpAdapter } from "./smtp";

/** The email connectors, by kind. */
export const emailAdapters: Record<string, Adapter> = {
  gmail: gmailAdapter,
  microsoft365: microsoft365Adapter,
  smtp: smtpAdapter,
};
