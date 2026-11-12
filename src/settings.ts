import type { Clock } from "./clock";
import { config, type EmailMode, type Lang, type ShiftDef } from "./config";
import { MIN } from "./time";

/**
 * Scheduling settings edited on the management screen. Defaults come from config.ts; overrides are stored in
 * D1 (`settings`, key "schedule") and applied onto `config` at the start of every request and scheduler run,
 * so business code keeps reading `config`.
 */
export interface Schedule {
  /** Ordered list; management adds, renames, retimes and removes shifts. */
  shifts: ShiftDef[];
  reminderTime: string;
  earlyGraceMinutes: number;
  lateAfterMinutes: number;
  missedAfterMinutes: number;
  quietHours: { start: string; end: string };
  confirmOnCheckin: boolean;
  messageLanguage: Lang;
  emailMode: EmailMode;
}

const pick = (): Schedule => structuredClone({
  shifts: config.shiftList,
  reminderTime: config.reminderTime,
  earlyGraceMinutes: config.earlyGraceMinutes,
  lateAfterMinutes: config.lateAfterMinutes,
  missedAfterMinutes: config.missedAfterMinutes,
  quietHours: config.quietHours,
  confirmOnCheckin: config.confirmOnCheckin,
  messageLanguage: config.messageLanguage,
  emailMode: config.emailMode,
});

export const DEFAULTS: Schedule = pick();
export const currentSchedule = pick;

/** Settings saved before 1.1 stored shifts as {AM: {start, end}, PM: {...}}. */
function shiftListOf(shifts: unknown): ShiftDef[] | undefined {
  if (Array.isArray(shifts)) return shifts as ShiftDef[];
  if (shifts && typeof shifts === "object") {
    return Object.entries(shifts as Record<string, { start: string; end: string }>).map(([code, t]) => ({ code, name: "", start: t?.start, end: t?.end }));
  }
  return undefined;
}

export function applySchedule(s: Partial<Schedule> | Record<string, unknown>) {
  const v = { ...structuredClone(DEFAULTS), ...structuredClone(s) } as Schedule;
  const list = shiftListOf(v.shifts) ?? DEFAULTS.shifts;
  const { shifts: _, ...rest } = v;
  Object.assign(config, rest, {
    shiftList: list,
    shifts: Object.fromEntries(list.map((x) => [x.code, { start: x.start, end: x.end, name: x.name || undefined }])),
  });
}

export async function loadSchedule(db: D1Database) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'schedule'").first<{ value: string }>();
  applySchedule(row ? JSON.parse(row.value) : {});
}

/** Display name of a shift code (its configured name, else the code). */
export const shiftLabel = (code: string) => config.shifts[code]?.name || code;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Same rule as roster files (src/importer.ts). */
const SHIFT_CODE = new RegExp(`^[A-Z0-9_-]{1,${config.shiftCodeMaxLength}}$`);
const int = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/** Returns an error code + field, or the clean value. */
export function validateSchedule(b: any): { ok: true; value: Schedule } | { ok: false; error: string; field: string } {
  const bad = (field: string, error = "invalid") => ({ ok: false as const, error, field });
  const list = shiftListOf(b?.shifts);
  if (!list || !list.length) return bad("shifts", "no_shifts");
  if (list.length > config.maxShifts) return bad("shifts", "too_many_shifts");
  const shifts: ShiftDef[] = [];
  for (const [i, sh] of list.entries()) {
    const code = typeof sh?.code === "string" ? sh.code.trim().toUpperCase() : "";
    const name = typeof sh?.name === "string" ? sh.name.trim() : "";
    if (!SHIFT_CODE.test(code)) return bad(`shifts.${i}.code`, "invalid_shift_code");
    if (shifts.some((x) => x.code === code)) return bad(`shifts.${i}.code`, "duplicate_shift_code");
    if (name.length > 40) return bad(`shifts.${i}.name`, "name_too_long");
    if (!HHMM.test(sh?.start ?? "")) return bad(`shifts.${i}.start`, "invalid_time");
    if (!HHMM.test(sh?.end ?? "")) return bad(`shifts.${i}.end`, "invalid_time");
    if (sh.end <= sh.start) return bad(`shifts.${i}.end`, "end_before_start");
    shifts.push({ code, name, start: sh.start, end: sh.end });
  }
  if (!HHMM.test(b.reminderTime ?? "")) return bad("reminderTime", "invalid_time");
  if (!int(b.earlyGraceMinutes, 0, 120)) return bad("earlyGraceMinutes", "out_of_range");
  if (!int(b.lateAfterMinutes, 0, 240)) return bad("lateAfterMinutes", "out_of_range");
  if (!int(b.missedAfterMinutes, 5, 240)) return bad("missedAfterMinutes", "out_of_range");
  if (!HHMM.test(b.quietHours?.start ?? "") || !HHMM.test(b.quietHours?.end ?? "")) return bad("quietHours", "invalid_time");
  if (b.quietHours.start === b.quietHours.end) return bad("quietHours", "invalid");
  if (typeof b.confirmOnCheckin !== "boolean") return bad("confirmOnCheckin");
  if (b.messageLanguage !== "th" && b.messageLanguage !== "en") return bad("messageLanguage");
  // Older saved settings (and clients) have no emailMode: keep it off.
  const emailMode = b.emailMode ?? "off";
  if (!["off", "fallback", "all"].includes(emailMode)) return bad("emailMode");
  return {
    ok: true,
    value: {
      shifts,
      reminderTime: b.reminderTime, earlyGraceMinutes: b.earlyGraceMinutes, lateAfterMinutes: b.lateAfterMinutes,
      missedAfterMinutes: b.missedAfterMinutes, quietHours: { start: b.quietHours.start, end: b.quietHours.end },
      confirmOnCheckin: b.confirmOnCheckin, messageLanguage: b.messageLanguage, emailMode,
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
