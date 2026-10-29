import type { Clock } from "./clock";
import { config, type Lang } from "./config";
import { MIN } from "./time";

/**
 * Scheduling settings edited on the management screen. Defaults come from config.ts; overrides are stored in
 * D1 (`settings`, key "schedule") and applied onto `config` at the start of every request and scheduler run,
 * so business code keeps reading `config`.
 */
export interface Schedule {
  shifts: { AM: { start: string; end: string }; PM: { start: string; end: string } };
  reminderTime: string;
  earlyGraceMinutes: number;
  lateAfterMinutes: number;
  missedAfterMinutes: number;
  quietHours: { start: string; end: string };
  confirmOnCheckin: boolean;
  messageLanguage: Lang;
}

const pick = (): Schedule => structuredClone({
  shifts: { AM: config.shifts.AM, PM: config.shifts.PM },
  reminderTime: config.reminderTime,
  earlyGraceMinutes: config.earlyGraceMinutes,
  lateAfterMinutes: config.lateAfterMinutes,
  missedAfterMinutes: config.missedAfterMinutes,
  quietHours: config.quietHours,
  confirmOnCheckin: config.confirmOnCheckin,
  messageLanguage: config.messageLanguage,
});

export const DEFAULTS: Schedule = pick();
export const currentSchedule = pick;

export function applySchedule(s: Partial<Schedule>) {
  const v = { ...structuredClone(DEFAULTS), ...structuredClone(s) };
  Object.assign(config, { ...v, shifts: { ...config.shifts, ...v.shifts } });
}

export async function loadSchedule(db: D1Database) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'schedule'").first<{ value: string }>();
  applySchedule(row ? JSON.parse(row.value) : {});
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const int = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/** Returns an error code + field, or the clean value. */
export function validateSchedule(b: any): { ok: true; value: Schedule } | { ok: false; error: string; field: string } {
  const bad = (field: string, error = "invalid") => ({ ok: false as const, error, field });
  for (const k of ["AM", "PM"] as const) {
    const sh = b?.shifts?.[k];
    if (!HHMM.test(sh?.start ?? "") || !HHMM.test(sh?.end ?? "")) return bad(`shifts.${k}`, "invalid_time");
    if (sh.end <= sh.start) return bad(`shifts.${k}`, "end_before_start");
  }
  if (!HHMM.test(b.reminderTime ?? "")) return bad("reminderTime", "invalid_time");
  if (!int(b.earlyGraceMinutes, 0, 120)) return bad("earlyGraceMinutes", "out_of_range");
  if (!int(b.lateAfterMinutes, 0, 240)) return bad("lateAfterMinutes", "out_of_range");
  if (!int(b.missedAfterMinutes, 5, 240)) return bad("missedAfterMinutes", "out_of_range");
  if (!HHMM.test(b.quietHours?.start ?? "") || !HHMM.test(b.quietHours?.end ?? "")) return bad("quietHours", "invalid_time");
  if (b.quietHours.start === b.quietHours.end) return bad("quietHours", "invalid");
  if (typeof b.confirmOnCheckin !== "boolean") return bad("confirmOnCheckin");
  if (b.messageLanguage !== "th" && b.messageLanguage !== "en") return bad("messageLanguage");
  return {
    ok: true,
    value: {
      shifts: { AM: { start: b.shifts.AM.start, end: b.shifts.AM.end }, PM: { start: b.shifts.PM.start, end: b.shifts.PM.end } },
      reminderTime: b.reminderTime, earlyGraceMinutes: b.earlyGraceMinutes, lateAfterMinutes: b.lateAfterMinutes,
      missedAfterMinutes: b.missedAfterMinutes, quietHours: { start: b.quietHours.start, end: b.quietHours.end },
      confirmOnCheckin: b.confirmOnCheckin, messageLanguage: b.messageLanguage,
    },
  };
}

/**
 * Save and apply. Messages already planned but never attempted (future, QUEUED, 0 attempts) are deleted so the
 * next scheduler run re-plans them with the new times. Messages already sent or in retry are left alone.
 * New shift times apply to duties created from now on; existing duties keep the times they were published with.
 */
export async function saveSchedule(db: D1Database, clock: Clock, actor: string, input: unknown) {
  const v = validateSchedule(input);
  if (!v.ok) return v;
  const now = clock.now();
  const [, , replan] = await db.batch([
    db.prepare(`INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('schedule', ?, ?, ?)
                ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .bind(JSON.stringify(v.value), now, actor),
    db.prepare("INSERT INTO audit_log (at, actor, event, detail) VALUES (?, ?, 'schedule_saved', ?)").bind(now, actor, JSON.stringify(v.value)),
    db.prepare(`DELETE FROM outbox WHERE status = 'QUEUED' AND attempts = 0 AND kind IN ('REMINDER', 'MISSED') AND due_at > ?`)
      .bind(now + MIN),
  ]);
  applySchedule(v.value);
  return { ok: true as const, value: v.value, replanned: replan.meta.changes ?? 0 };
}

export async function scheduleInfo(db: D1Database) {
  const row = await db.prepare("SELECT updated_at, updated_by FROM settings WHERE key = 'schedule'").first<{ updated_at: number; updated_by: string }>();
  return { schedule: currentSchedule(), defaults: DEFAULTS, updatedAt: row?.updated_at ?? null, updatedBy: row?.updated_by ?? null };
}
