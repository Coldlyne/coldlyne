import "server-only";
import type { Services } from "@/application/services";
import { db } from "./db/client";
import { env } from "./env";

/** The services a request runs with: the instance's database and settings, the real network and clock. */
export const appServices = (): Services => ({ db: db(), settings: env(), fetch, now: () => new Date() });
