import { config } from "./config";

export const MIN = 60_000;
const DAY = 86_400_000;

/** Bangkok calendar date ('YYYY-MM-DD') of a UTC instant. Never use the UTC date for duty dates. */
export function bangkokDateOf(utcMs: number): string {
  return new Date(utcMs + config.tzOffsetMinutes * MIN).toISOString().slice(0, 10);
}

/** Bangkok wall-clock 'HH:MM' of a UTC instant. */
export function bangkokTimeOf(utcMs: number): string {
  return new Date(utcMs + config.tzOffsetMinutes * MIN).toISOString().slice(11, 16);
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

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** True if `t` falls in config.quietHours (Bangkok). The window may wrap midnight. */
export function inQuietHours(t: number): boolean {
  const m = minutesOf(bangkokTimeOf(t));
  const s = minutesOf(config.quietHours.start), e = minutesOf(config.quietHours.end);
  return s <= e ? m >= s && m < e : m >= s || m < e;
}

/** `t` if outside quiet hours, else the next quiet-hours end. */
export function afterQuietHours(t: number): number {
  if (!inQuietHours(t)) return t;
  const date = bangkokDateOf(t);
  const end = bangkokInstant(date, config.quietHours.end);
  return end > t ? end : bangkokInstant(date, config.quietHours.end, 1);
}

/** 'Thu 30 Oct 2026' for a Bangkok date. */
export function dateLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1];
  return `${wd} ${d} ${mon} ${y}`;
}
