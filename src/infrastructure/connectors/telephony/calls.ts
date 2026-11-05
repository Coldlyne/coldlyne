import type { Signal, SignalType } from "@/application/ports";

/** What the telephony adapters say alike: a call's outcome, and the numbers found on an account. */

function spokenDuration(seconds: number): string {
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  return minutes ? `${minutes}\u00A0min\u00A0${whole % 60}\u00A0s` : `${whole}\u00A0s`;
}

/** A call's outcome as a signal. `address` is the prospect's number, `seconds` the time on the line. */
export function callSignal(outcome: { type: SignalType; externalId: string; address: string | null; at: Date; seconds?: number | null }): Signal {
  const { seconds, ...signal } = outcome;
  return { ...signal, channel: "call", detail: seconds ? spokenDuration(seconds) : undefined };
}

/**
 * A call that comes in: the person answers an earlier call by calling back, picked up or not. It
 * is only ever kept for someone the workspace reached out to, like any signal.
 */
export const callback = (call: { externalId: string; address: string | null; at: Date }): Signal => ({ ...call, type: "replied", channel: "call", detail: "A rappelé" });

/** "1 numéro : +33…", "2 numéros : +33…, +33…". */
export function numbersDetail(numbers: readonly string[]): string {
  return `${numbers.length} numéro${numbers.length > 1 ? "s" : ""}\u00A0: ${numbers.join(", ")}`;
}
