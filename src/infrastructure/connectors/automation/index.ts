import type { Adapter } from "../adapter";
import { signups } from "./signups";
import { slack } from "./slack";
import { webhook } from "./webhook";

/** The automation connectors, by kind. */
export const automationAdapters: Record<string, Adapter> = { slack, webhook, signups };
