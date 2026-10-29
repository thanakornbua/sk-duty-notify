import type { Clock } from "./clock";
import { config } from "./config";
import { haversineM } from "./geo";
import { addDays, bangkokDateOf, bangkokInstant, MIN } from "./time";

interface DutyRow {
  id: number; duty_date: string; shift: string; start_at: number; end_at: number; status: string; late: number | null;
  checked_in_at: number | null; source: string | null; override_note: string | null;
  member_id: number; staff_code: string; label: string; linked: number; location: string;
}
interface OutRow { id: number; kind: string; member_id: number; duty_id: number | null; status: string; accepted_at: number | null; last_error: string | null; attempts: number }
interface Attempt {
  id: number; duty_id: number | null; member_id: number | null; submitted_at: number; client_ts: number | null;
  lat: number | null; lng: number | null; accuracy_m: number | null; distance_m: number | null; result: string; reason: string | null;
}

const DUTIES_SQL = `
  SELECT d.id, d.duty_date, d.shift, d.start_at, d.end_at, d.status, d.late, d.checked_in_at, d.source, d.override_note,
         m.id AS member_id, m.staff_code, m.label, (m.line_user_id IS NOT NULL) AS linked, l.name AS location
  FROM duties d JOIN members m ON m.id = d.member_id JOIN locations l ON l.id = d.location_id`;

export interface Anomaly { kind: string; memberIds: number[]; detail: string }

/** Flags for admin review only; nothing is auto-rejected (spec 8.4). */
export function findAnomalies(attempts: Attempt[]): Anomaly[] {
  const out: Anomaly[] = [];
  const A = config.anomaly;

  // Identical coordinates (to ~0.1 m) reported by different members.
  const byCoord = new Map<string, Set<number>>();
  for (const a of attempts) {
    if (a.lat == null || a.lng == null || a.member_id == null) continue;
    const k = `${a.lat.toFixed(6)},${a.lng.toFixed(6)}`;
    byCoord.set(k, (byCoord.get(k) ?? new Set()).add(a.member_id));
  }
  for (const [k, ids] of byCoord) if (ids.size > 1) out.push({ kind: "identical_coords", memberIds: [...ids], detail: k });

  const byMember = new Map<number, Attempt[]>();
  for (const a of attempts) if (a.member_id != null) byMember.set(a.member_id, [...(byMember.get(a.member_id) ?? []), a]);
  for (const [mid, list] of byMember) {
    list.sort((x, y) => x.submitted_at - y.submitted_at);
    const low = list.filter((a) => a.result === "low_accuracy").length;
    if (low >= A.repeatedLowAccuracy) out.push({ kind: "repeated_low_accuracy", memberIds: [mid], detail: `${low} low-accuracy attempts` });
    for (const a of list) {
      if (a.accuracy_m != null && a.accuracy_m < 1) out.push({ kind: "zero_accuracy", memberIds: [mid], detail: `attempt #${a.id} reported ${a.accuracy_m} m` });
      if (a.client_ts != null && Math.abs(a.client_ts - a.submitted_at) > A.clockSkewMinutes * MIN) {
        out.push({ kind: "clock_skew", memberIds: [mid], detail: `attempt #${a.id}: phone clock off by ${Math.round((a.client_ts - a.submitted_at) / MIN)} min` });
      }
    }
    const located = list.filter((a) => a.lat != null && a.lng != null);
    for (let i = 1; i < located.length; i++) {
      const p = located[i - 1], q = located[i];
      // Ignore movement that the reported accuracy could explain.
      const d = haversineM(p.lat!, p.lng!, q.lat!, q.lng!) - (p.accuracy_m ?? 0) - (q.accuracy_m ?? 0);
      const hours = Math.max(q.submitted_at - p.submitted_at, 1000) / 3_600_000;
      if (d > 0 && d / 1000 / hours > A.maxSpeedKmh) {
        out.push({ kind: "impossible_jump", memberIds: [mid], detail: `#${p.id} -> #${q.id}: ${Math.round(d)} m in ${Math.round(hours * 3600)} s` });
      }
    }
  }
  return out;
}

const dayBounds = (date: string) => [bangkokInstant(date, "00:00"), bangkokInstant(date, "00:00", 1)] as const;

export async function buildToday(db: D1Database, clock: Clock, date?: string) {
  const now = clock.now();
  const today = bangkokDateOf(now);
  const day = date ?? today;
  const [from, to] = dayBounds(day);

  const [duties, outbox, attempts, rosterDates, hb, failed] = await Promise.all([
    db.prepare(`${DUTIES_SQL} WHERE d.duty_date = ? AND d.status != 'CANCELLED' ORDER BY d.start_at, m.staff_code`).bind(day).all<DutyRow>(),
    db.prepare("SELECT id, kind, member_id, duty_id, status, accepted_at, last_error, attempts FROM outbox WHERE duty_date = ?").bind(day).all<OutRow>(),
    db.prepare(`SELECT id, duty_id, member_id, submitted_at, client_ts, lat, lng, accuracy_m, distance_m, result, reason
                FROM checkins WHERE submitted_at >= ? AND submitted_at < ? ORDER BY submitted_at`).bind(from, to).all<Attempt>(),
    db.prepare("SELECT duty_date FROM roster_dates WHERE duty_date IN (?, ?, ?)").bind(day, today, addDays(today, 1)).all<{ duty_date: string }>(),
    db.prepare("SELECT last_run_at FROM scheduler_heartbeat WHERE id = 1").first<{ last_run_at: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status = 'FAILED' AND duty_date >= ?").bind(addDays(today, -1)).first<{ n: number }>(),
  ]);

  const known = new Set(rosterDates.results.map((r) => r.duty_date));
  const pushes = (memberId: number, dutyId: number) => {
    const pick = (kind: string) => {
      const o = outbox.results.find((r) => r.kind === kind && r.member_id === memberId && (kind === "REMINDER" || r.duty_id === dutyId));
      return o ? { status: o.status, acceptedAt: o.accepted_at, error: o.last_error, attempts: o.attempts } : null;
    };
    return { REMINDER: pick("REMINDER"), PROMPT: pick("PROMPT"), MISSED: pick("MISSED"), CONFIRM: pick("CONFIRM") };
  };

  const rows = duties.results.map((d) => {
    const mine = attempts.results.filter((a) => a.duty_id === d.id);
    const last = mine[mine.length - 1];
    return {
      id: d.id, staffCode: d.staff_code, label: d.label, linked: d.linked === 1, shift: d.shift, location: d.location,
      startAt: d.start_at, endAt: d.end_at, status: d.status, late: d.late === 1, checkedInAt: d.checked_in_at,
      source: d.source, overrideNote: d.override_note,
      attempts: mine.length, rejected: mine.filter((a) => a.result !== "ok").length,
      lastAttempt: last ? { at: last.submitted_at, result: last.result, reason: last.reason, distanceM: last.distance_m, accuracyM: last.accuracy_m } : null,
      push: pushes(d.member_id, d.id),
    };
  });

  const count = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).length;
  // `detail` is English for logs; pages translate `code` with `params`.
  const alerts: { level: "high" | "warn"; code: string; detail: string; params?: Record<string, string | number> }[] = [];
  if (!hb) alerts.push({ level: "high", code: "scheduler_never_ran", detail: "no scheduler heartbeat yet" });
  else if (now - hb.last_run_at > config.heartbeatStaleMinutes * MIN) {
    const minutes = Math.round((now - hb.last_run_at) / MIN);
    alerts.push({ level: "high", code: "scheduler_stale", detail: `last run ${minutes} min ago`, params: { minutes } });
  }
  if (!known.has(today)) alerts.push({ level: "high", code: "roster_unknown_today", detail: `no roster loaded for ${today}`, params: { date: today } });
  const tomorrow = addDays(today, 1);
  if (!known.has(tomorrow)) alerts.push({ level: "warn", code: "roster_unknown_tomorrow", detail: `no roster loaded for ${tomorrow}`, params: { date: tomorrow } });
  if (failed?.n) alerts.push({ level: "high", code: "push_failed", detail: `${failed.n} push(es) failed since yesterday`, params: { count: failed.n } });
  const unlinked = new Set(rows.filter((r) => !r.linked).map((r) => r.staffCode));
  if (unlinked.size) alerts.push({ level: "warn", code: "unlinked_on_duty", detail: [...unlinked].join(", "), params: { codes: [...unlinked].join(", ") } });

  return {
    date: day, serverNow: now, rosterKnown: known.has(day),
    counts: {
      total: rows.length, checkedIn: count((r) => r.status === "CHECKED_IN"), late: count((r) => r.late),
      pending: count((r) => r.status === "PENDING"), missed: count((r) => r.status === "MISSED"),
      rejectedAttempts: attempts.results.filter((a) => a.result !== "ok").length,
    },
    duties: rows,
    anomalies: findAnomalies(attempts.results),
    alerts,
  };
}

/** Raw attempts with coordinates. Admin only (spec 8.5). */
export async function attemptsFor(db: D1Database, date: string) {
  const [from, to] = dayBounds(date);
  return (await db.prepare(
    `SELECT c.id, c.duty_id, m.staff_code, c.submitted_at, c.client_ts, c.lat, c.lng, c.accuracy_m, c.distance_m, c.result, c.reason
     FROM checkins c LEFT JOIN members m ON m.id = c.member_id
     WHERE c.submitted_at >= ? AND c.submitted_at < ? ORDER BY c.submitted_at`,
  ).bind(from, to).all()).results;
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  // Quote everything that needs it, and neutralise spreadsheet formulas.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) || safe !== s ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const iso = (t: number | null) => (t == null ? "" : new Date(t + config.tzOffsetMinutes * MIN).toISOString().slice(0, 16).replace("T", " "));

/** Check-in report for an inclusive Bangkok date range. No raw coordinates. */
export async function exportCsv(db: D1Database, from: string, to: string): Promise<string> {
  const { results } = await db.prepare(
    `${DUTIES_SQL} WHERE d.duty_date BETWEEN ? AND ? AND d.status != 'CANCELLED' ORDER BY d.duty_date, d.start_at, m.staff_code`,
  ).bind(from, to).all<DutyRow>();
  const stats = (await db.prepare(
    `SELECT duty_id, COUNT(*) AS n, SUM(result != 'ok') AS rejected FROM checkins
     WHERE duty_id IN (SELECT id FROM duties WHERE duty_date BETWEEN ? AND ?) GROUP BY duty_id`,
  ).bind(from, to).all<{ duty_id: number; n: number; rejected: number }>()).results;
  const by = new Map(stats.map((s) => [s.duty_id, s]));
  const head = ["date", "staff_code", "label", "shift", "location", "start", "end", "status", "late", "checked_in_at", "source", "override_note", "attempts", "rejected_attempts"];
  const lines = [head.join(",")];
  for (const d of results) {
    const s = by.get(d.id);
    lines.push([d.duty_date, d.staff_code, d.label, d.shift, d.location, iso(d.start_at).slice(11), iso(d.end_at).slice(11), d.status,
      d.late === 1 ? "yes" : d.status === "CHECKED_IN" ? "no" : "", iso(d.checked_in_at), d.source ?? "", d.override_note ?? "",
      s?.n ?? 0, s?.rejected ?? 0].map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
