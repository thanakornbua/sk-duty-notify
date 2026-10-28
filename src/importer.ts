import type { Clock } from "./clock";
import { config } from "./config";
import type { NormalizedImport } from "../public/grid";

export type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 400;

function validDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Revalidate untrusted JSON. Never trusts what the browser parsed. Returns the canonical form. */
export async function validateImport(db: D1Database, input: unknown): Promise<Result<NormalizedImport>> {
  const errors: string[] = [];
  const days = (input as { days?: unknown } | null)?.days;
  if (!Array.isArray(days)) return { ok: false, errors: ["Body must be {days: [...]}"] };
  if (days.length === 0) return { ok: false, errors: ["No days"] };
  if (days.length > MAX_DAYS) return { ok: false, errors: [`Too many days (max ${MAX_DAYS})`] };

  const { results } = await db.prepare("SELECT staff_id FROM people WHERE active = 1").all<{ staff_id: string }>();
  const known = new Set(results.map((r) => r.staff_id));
  const positionSet = new Set<string>(config.positions);

  const seenDates = new Set<string>();
  const out: NormalizedImport["days"] = [];
  for (const [i, day] of days.entries()) {
    const date = (day as { date?: unknown })?.date;
    const assignments = (day as { assignments?: unknown })?.assignments;
    if (typeof date !== "string" || !validDate(date)) { errors.push(`Day #${i + 1}: invalid date`); continue; }
    if (seenDates.has(date)) { errors.push(`${date}: duplicate date`); continue; }
    seenDates.add(date);
    if (!Array.isArray(assignments)) { errors.push(`${date}: assignments must be an array`); continue; }

    const clean: { position: string; staffId: string }[] = [];
    let dayOk = true;
    const pos = new Set<string>(), staff = new Set<string>();
    for (const a of assignments) {
      const position = (a as { position?: unknown })?.position;
      const staffId = (a as { staffId?: unknown })?.staffId;
      if (typeof position !== "string" || typeof staffId !== "string") { errors.push(`${date}: malformed assignment`); dayOk = false; continue; }
      if (!positionSet.has(position)) { errors.push(`${date}: unknown position ${position}`); dayOk = false; }
      if (pos.has(position)) { errors.push(`${date}: position ${position} filled twice`); dayOk = false; }
      if (staff.has(staffId)) { errors.push(`${date}: staff ${staffId} assigned twice`); dayOk = false; }
      if (!known.has(staffId)) { errors.push(`${date}: unknown or inactive staff ${staffId}`); dayOk = false; }
      pos.add(position); staff.add(staffId);
      clean.push({ position, staffId });
    }
    // Empty list = explicit NO_DUTY. Anything else must fill every position (=> exactly dutyPerDay people).
    if (clean.length !== 0 && dayOk) {
      const missing = config.positions.filter((p) => !pos.has(p));
      if (missing.length) { errors.push(`${date}: positions not filled: ${missing.join(", ")}`); dayOk = false; }
    }
    if (dayOk) out.push({ date, assignments: clean.sort((a, b) => a.position.localeCompare(b.position)) });
  }
  if (errors.length) return { ok: false, errors };
  out.sort((a, b) => a.date.localeCompare(b.date));
  return { ok: true, value: { days: out } };
}

export async function contentHash(data: NormalizedImport): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type StageResult = { id: number; status: string; duplicate: boolean };

/** Stage a validated roster. Nothing is written unless validation passes; the writes are one atomic batch. */
export async function stageImport(db: D1Database, clock: Clock, input: unknown): Promise<Result<StageResult>> {
  const v = await validateImport(db, input);
  if (!v.ok) return v;
  const hash = await contentHash(v.value);

  const existing = await db.prepare("SELECT id, status FROM roster_revisions WHERE content_hash = ?")
    .bind(hash).first<{ id: number; status: string }>();
  if (existing) return { ok: true, value: { id: existing.id, status: existing.status, duplicate: true } };

  const now = clock.now();
  const stmts: D1PreparedStatement[] = [
    db.prepare("INSERT INTO roster_revisions (content_hash, status, created_at) VALUES (?, 'STAGED', ?)").bind(hash, now),
  ];
  const rev = "(SELECT id FROM roster_revisions WHERE content_hash = ?)";
  for (const day of v.value.days) {
    stmts.push(db.prepare(`INSERT INTO roster_days (revision_id, duty_date, state) VALUES (${rev}, ?, ?)`)
      .bind(hash, day.date, day.assignments.length ? "DUTY" : "NO_DUTY"));
    for (const a of day.assignments) {
      stmts.push(db.prepare(
        `INSERT INTO assignments (revision_id, duty_date, position, staff_id, is_active) VALUES (${rev}, ?, ?, ?, 0)`,
      ).bind(hash, day.date, a.position, a.staffId));
    }
  }
  stmts.push(db.prepare("INSERT INTO audit_log (at, actor, event, detail) VALUES (?, 'admin', 'import_staged', ?)")
    .bind(now, JSON.stringify({ hash, days: v.value.days.length })));
  try {
    await db.batch(stmts);
  } catch (e) {
    // Lost a race with an identical concurrent stage: treat as the duplicate it is.
    const again = await db.prepare("SELECT id, status FROM roster_revisions WHERE content_hash = ?")
      .bind(hash).first<{ id: number; status: string }>();
    if (again) return { ok: true, value: { id: again.id, status: again.status, duplicate: true } };
    throw e;
  }
  const row = await db.prepare("SELECT id, status FROM roster_revisions WHERE content_hash = ?")
    .bind(hash).first<{ id: number; status: string }>();
  return { ok: true, value: { id: row!.id, status: row!.status, duplicate: false } };
}

/**
 * Activate a staged revision: revalidate what is stored (staff may have been deactivated since staging),
 * then supersede the old revision and activate the new one in a single atomic batch.
 */
export async function publishImport(db: D1Database, clock: Clock, id: number): Promise<Result<{ id: number; status: string }> & { status?: number }> {
  const rev = await db.prepare("SELECT id, status FROM roster_revisions WHERE id = ?")
    .bind(id).first<{ id: number; status: string }>();
  if (!rev) return { ok: false, errors: ["No such revision"], status: 404 };
  if (rev.status === "ACTIVE") return { ok: true, value: { id, status: "ACTIVE" } };
  if (rev.status !== "STAGED") return { ok: false, errors: [`Revision is ${rev.status}, cannot publish`], status: 409 };

  const [days, asg] = await Promise.all([
    db.prepare("SELECT duty_date, state FROM roster_days WHERE revision_id = ?").bind(id).all<{ duty_date: string; state: string }>(),
    db.prepare("SELECT duty_date, position, staff_id FROM assignments WHERE revision_id = ?").bind(id)
      .all<{ duty_date: string; position: string; staff_id: string }>(),
  ]);
  const byDate = new Map(days.results.map((d) => [d.duty_date, { date: d.duty_date, assignments: [] as { position: string; staffId: string }[] }]));
  for (const a of asg.results) byDate.get(a.duty_date)?.assignments.push({ position: a.position, staffId: a.staff_id });
  const v = await validateImport(db, { days: [...byDate.values()] });
  if (!v.ok) return { ...v, status: 422 };

  const now = clock.now();
  await db.batch([
    db.prepare("UPDATE assignments SET is_active = 0 WHERE is_active = 1"),
    db.prepare("UPDATE roster_revisions SET status = 'SUPERSEDED' WHERE status = 'ACTIVE'"),
    db.prepare("UPDATE assignments SET is_active = 1 WHERE revision_id = ?").bind(id),
    db.prepare("UPDATE roster_revisions SET status = 'ACTIVE', published_at = ? WHERE id = ?").bind(now, id),
    db.prepare("INSERT INTO audit_log (at, actor, event, detail) VALUES (?, 'admin', 'import_published', ?)")
      .bind(now, JSON.stringify({ id })),
  ]);
  return { ok: true, value: { id, status: "ACTIVE" } };
}
