import type { Clock } from "./clock";
import { config } from "./config";
import { bangkokInstant } from "./time";
import { sha256Hex } from "./util";

/**
 * Roster import. The browser parses CSV/XLSX into rows; nothing it sends is trusted, everything is revalidated here.
 * A row with an empty staffCode is an explicit "no duty" marker for its date.
 */
export interface RosterRow {
  date: string;
  staffCode: string;
  locationCode: string;
  shift: string;
  start?: string;
  end?: string;
  /** Source line in the file, for error messages only. */
  line?: number;
}

interface Resolved { memberId: number; locationId: number; date: string; shift: string; startAt: number; endAt: number; label: string }

/** A validation problem or warning. `code` is translated by the UI; the other fields fill its message. */
export type Issue = { code: string; row?: number; date?: string; value?: string; [k: string]: string | number | undefined };
export type Result<T> = { ok: true; value: T } | { ok: false; errors: Issue[]; status?: number };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const SHIFT_RE = new RegExp(`^[A-Za-z0-9_-]{1,${config.shiftCodeMaxLength}}$`);
const MAX_ROWS = 5000;

function validDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2200) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

/** Validate rows against the current members and locations. */
async function resolveRows(db: D1Database, input: unknown): Promise<Result<{ rows: RosterRow[]; resolved: Resolved[]; dates: string[] }>> {
  const raw = (input as { rows?: unknown })?.rows;
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, errors: [{ code: "rows_required" }] };
  if (raw.length > MAX_ROWS) return { ok: false, errors: [{ code: "too_many_rows", max: MAX_ROWS }] };

  const [members, locations] = await Promise.all([
    db.prepare("SELECT id, staff_code, active FROM members").all<{ id: number; staff_code: string; active: number }>(),
    db.prepare(`SELECT l.id, l.code, l.active, (SELECT COUNT(*) FROM geofence_points p WHERE p.location_id = l.id AND p.retired_at IS NULL) AS points
                FROM locations l`).all<{ id: number; code: string; active: number; points: number }>(),
  ]);
  const memberBy = new Map(members.results.map((m) => [m.staff_code, m]));
  const locationBy = new Map(locations.results.map((l) => [l.code, l]));

  const errors: Issue[] = [];
  const rows: RosterRow[] = [];
  const resolved: Resolved[] = [];
  const markers = new Set<string>(), withDuty = new Set<string>(), keys = new Set<string>();
  const dates = new Set<string>();

  raw.forEach((r: Record<string, unknown>, i) => {
    const line = Number.isInteger(r?.line) ? (r.line as number) : i + 1;
    const row: RosterRow = {
      date: str(r?.date), staffCode: str(r?.staffCode), locationCode: str(r?.locationCode), shift: str(r?.shift).toUpperCase(),
      start: str(r?.start) || undefined, end: str(r?.end) || undefined, line,
    };
    if (!validDate(row.date)) { errors.push({ code: "invalid_date", row: line, value: row.date }); return; }
    dates.add(row.date);
    rows.push(row);

    if (!row.staffCode) {
      if (row.locationCode || row.shift) errors.push({ code: "no_duty_row_not_empty", row: line });
      markers.add(row.date);
      return;
    }
    withDuty.add(row.date);

    const member = memberBy.get(row.staffCode);
    if (!member) errors.push({ code: "unknown_staff", row: line, value: row.staffCode });
    else if (!member.active) errors.push({ code: "inactive_staff", row: line, value: row.staffCode });
    const loc = locationBy.get(row.locationCode);
    if (!loc) errors.push({ code: "unknown_location", row: line, value: row.locationCode });
    else if (!loc.active) errors.push({ code: "inactive_location", row: line, value: row.locationCode });
    else if (!loc.points) errors.push({ code: "location_without_points", row: line, value: row.locationCode });

    if (!SHIFT_RE.test(row.shift)) { errors.push({ code: "invalid_shift", row: line, value: row.shift }); return; }
    const preset = config.shifts[row.shift];
    const start = row.start ?? preset?.start, end = row.end ?? preset?.end;
    if (!start || !end) { errors.push({ code: "shift_needs_times", row: line, value: row.shift }); return; }
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) { errors.push({ code: "invalid_time", row: line }); return; }
    if (end <= start) { errors.push({ code: "end_before_start", row: line, start, end }); return; }

    const key = `${row.staffCode}|${row.date}|${row.shift}`;
    if (keys.has(key)) errors.push({ code: "duplicate_shift", row: line, value: row.staffCode, shift: row.shift, date: row.date });
    keys.add(key);
    if (member && loc) {
      resolved.push({
        memberId: member.id, locationId: loc.id, date: row.date, shift: row.shift, label: `${row.staffCode} ${row.shift}`,
        startAt: bangkokInstant(row.date, start), endAt: bangkokInstant(row.date, end),
      });
    }
  });

  for (const d of markers) if (withDuty.has(d)) errors.push({ code: "mixed_no_duty", date: d });
  // The same member must not be in two places at once.
  const byMemberDate = new Map<string, Resolved[]>();
  for (const r of resolved) {
    const k = `${r.memberId}|${r.date}`;
    byMemberDate.set(k, [...(byMemberDate.get(k) ?? []), r]);
  }
  for (const list of byMemberDate.values()) {
    list.sort((a, b) => a.startAt - b.startAt);
    for (let i = 1; i < list.length; i++) {
      if (list[i].startAt < list[i - 1].endAt) errors.push({ code: "overlap", date: list[i].date, a: list[i - 1].label, b: list[i].label });
    }
  }
  if (errors.length) return { ok: false, errors: errors.slice(0, 200) };
  return { ok: true, value: { rows, resolved, dates: [...dates].sort() } };
}

interface Existing { id: number; member_id: number; location_id: number; duty_date: string; shift: string; start_at: number; end_at: number; status: string }

export interface ImportPlan {
  dates: string[];
  insert: Resolved[];
  cancel: number[];
  keep: number;
  warnings: Issue[];
}

/**
 * Batch = full snapshot for the dates it lists. Unchanged PENDING duties are kept (no re-notification);
 * changed or removed PENDING duties are cancelled (and re-created if changed). Resolved duties are never touched.
 */
async function planImport(db: D1Database, resolved: Resolved[], dates: string[]): Promise<ImportPlan> {
  const existing = (await db.prepare(
    `SELECT id, member_id, location_id, duty_date, shift, start_at, end_at, status FROM duties
     WHERE status != 'CANCELLED' AND duty_date IN (SELECT value FROM json_each(?))`,
  ).bind(JSON.stringify(dates)).all<Existing>()).results;
  const byKey = new Map(existing.map((e) => [`${e.member_id}|${e.duty_date}|${e.shift}`, e]));
  const plan: ImportPlan = { dates, insert: [], cancel: [], keep: 0, warnings: [] };
  const wanted = new Set<string>();

  for (const r of resolved) {
    const key = `${r.memberId}|${r.date}|${r.shift}`;
    wanted.add(key);
    const e = byKey.get(key);
    const same = e && e.location_id === r.locationId && e.start_at === r.startAt && e.end_at === r.endAt;
    if (!e) plan.insert.push(r);
    else if (e.status !== "PENDING") {
      plan.keep++;
      if (!same) plan.warnings.push({ code: "resolved_change_ignored", date: r.date, value: r.label, status: e.status });
    } else if (same) plan.keep++;
    else { plan.cancel.push(e.id); plan.insert.push(r); }
  }
  for (const [key, e] of byKey) {
    if (wanted.has(key)) continue;
    if (e.status === "PENDING") plan.cancel.push(e.id);
    else plan.warnings.push({ code: "resolved_kept", date: e.duty_date, value: `#${e.id} ${e.shift}`, status: e.status });
  }
  return plan;
}

const summary = (p: ImportPlan) => ({ dates: p.dates, insert: p.insert.length, cancel: p.cancel.length, keep: p.keep, warnings: p.warnings });

export async function stageImport(db: D1Database, clock: Clock, body: unknown) {
  const res = await resolveRows(db, body);
  if (!res.ok) return res;
  const { rows, resolved, dates } = res.value;
  const rowsJson = JSON.stringify(rows);
  const hash = await sha256Hex(rowsJson);
  const batch = await db.prepare(
    "INSERT INTO import_batches (status, content_hash, rows_json, dates_json, created_at) VALUES ('STAGED', ?, ?, ?, ?) RETURNING id",
  ).bind(hash, rowsJson, JSON.stringify(dates), clock.now()).first<{ id: number }>();
  // Preview only: publish recomputes against whatever is live at that moment.
  const plan = await planImport(db, resolved, dates);
  return { ok: true as const, value: { batchId: batch!.id, contentHash: hash, ...summary(plan) } };
}

export async function publishImport(db: D1Database, clock: Clock, batchId: number, actor = "admin"): Promise<Result<ReturnType<typeof summary>>> {
  const batch = await db.prepare("SELECT status, rows_json FROM import_batches WHERE id = ?").bind(batchId)
    .first<{ status: string; rows_json: string }>();
  if (!batch) return { ok: false, errors: [{ code: "unknown_batch" }], status: 404 };
  if (batch.status !== "STAGED") return { ok: false, errors: [{ code: "batch_not_staged", status: batch.status }], status: 409 };

  // Members or locations may have changed since staging.
  const res = await resolveRows(db, { rows: JSON.parse(batch.rows_json) });
  if (!res.ok) return res;
  const plan = await planImport(db, res.value.resolved, res.value.dates);
  const now = clock.now();

  // A concurrent double publish would try to insert the same live duties twice; the partial unique index then
  // fails that whole batch (D1 batches are one transaction).
  const stmts: D1PreparedStatement[] = [
    db.prepare("UPDATE import_batches SET status = 'PUBLISHED', published_at = ? WHERE id = ? AND status = 'STAGED'").bind(now, batchId),
  ];
  // Cancels first so the partial unique index never sees two live duties with the same key.
  for (const id of plan.cancel) {
    stmts.push(db.prepare("UPDATE duties SET status = 'CANCELLED', updated_at = ? WHERE id = ? AND status = 'PENDING'").bind(now, id));
  }
  for (const r of plan.insert) {
    stmts.push(db.prepare(
      `INSERT INTO duties (member_id, location_id, duty_date, shift, start_at, end_at, import_batch_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(r.memberId, r.locationId, r.date, r.shift, r.startAt, r.endAt, batchId, now, now));
  }
  for (const d of plan.dates) {
    stmts.push(db.prepare(
      "INSERT INTO roster_dates (duty_date, batch_id) VALUES (?, ?) ON CONFLICT (duty_date) DO UPDATE SET batch_id = excluded.batch_id",
    ).bind(d, batchId));
  }
  stmts.push(db.prepare("INSERT INTO audit_log (at, actor, event, detail) VALUES (?, ?, 'roster_published', ?)")
    .bind(now, actor, JSON.stringify({ batchId, ...summary(plan) })));
  await db.batch(stmts);
  return { ok: true, value: summary(plan) };
}
