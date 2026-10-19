// The prototype read the wall clock in its mutators (audit times, ids) and in
// one default parameter (ot-bank's `asOfDate`, statutory-engine's
// `generatedAt`). The pure calculation (`calculateCompanyEngine`) never reads
// it. Every such spot now takes a `PayrollClock`; a service passes its own,
// a check passes a fixed one, and the default is the system clock so a call
// that names none behaves as the prototype did.
import { randomUUID } from "node:crypto";

export interface PayrollClock {
  /** The current instant. */
  now(): Date;
  /** A fresh unique id (the prototype used `Date.now()` + `Math.random()`). */
  id(prefix: string): string;
}

export const systemClock: PayrollClock = {
  now: () => new Date(),
  id: (prefix) => `${prefix}-${randomUUID()}`,
};

/** A clock frozen at one instant, with ids counted up from 1 — for checks. */
export function fixedClock(iso: string): PayrollClock {
  let n = 0;
  return { now: () => new Date(iso), id: (prefix) => `${prefix}-${++n}` };
}

/** ISO date (YYYY-MM-DD) of the clock's instant, in UTC as the prototype took it. */
export const clockDate = (clock: PayrollClock) => clock.now().toISOString().slice(0, 10);
