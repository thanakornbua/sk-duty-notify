import { config } from "./config";

const MIN = 60_000;
const DAY = 86_400_000;

/** Bangkok calendar date ('YYYY-MM-DD') of a UTC instant. Never use the UTC date for duty dates. */
export function bangkokDateOf(utcMs: number): string {
  return new Date(utcMs + config.tzOffsetMinutes * MIN).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY).toISOString().slice(0, 10);
}

/** UTC instant of Bangkok wall-clock `hhmm` on (date + dayOffset). */
export function bangkokInstant(date: string, hhmm: string, dayOffset = 0): number {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  return Date.UTC(y, m - 1, d + dayOffset, hh, mm) - config.tzOffsetMinutes * MIN;
}
