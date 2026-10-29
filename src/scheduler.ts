import type { Clock } from "./clock";
import { config, type MessageKind } from "./config";
import type { LineClient, PushResult } from "./line";
import { buildMessages, type DutyInfo } from "./messages";
import { addDays, afterQuietHours, bangkokDateOf, bangkokInstant, inQuietHours, MIN } from "./time";

export interface OutboxRow {
  id: number;
  kind: MessageKind;
  member_id: number;
  duty_date: string;
  duty_id: number | null;
  status: string;
  deadline_at: number;
  attempts: number;
  target_user_id: string | null;
  payload: string | null;
  retry_key: string | null;
  line_request_id: string | null;
}

export interface SchedulerDeps {
  db: D1Database;
  clock: Clock;
  /** Omit to plan/sweep/heartbeat only (nothing is sent). */
  line?: LineClient;
  /** Needed to build the check-in link. Without it, jobs wait (they are not consumed). */
  liffId?: string;
  owner?: string;
  rand?: () => number;
  batchSize?: number;
  /** Test seam: called right after LINE accepted, before the DB write that records it. */
  hooks?: { afterApiAccepted?: (row: OutboxRow) => void | Promise<void> };
}

export interface Summary {
  planned: number;
  missed: number;
  swept: number;
  purged: number;
  reaped: number;
  claimed: number;
  accepted: number;
  retried: number;
  failed: number;
  suppressed: number;
  cancelled: number;
}

export async function runScheduler(deps: SchedulerDeps): Promise<Summary> {
  const { db, clock } = deps;
  const s: Summary = { planned: 0, missed: 0, swept: 0, purged: 0, reaped: 0, claimed: 0, accepted: 0, retried: 0, failed: 0, suppressed: 0, cancelled: 0 };
  const now = clock.now();

  s.planned = await planOutbox(db, now);
  s.missed = await markMissed(db, now);
  s.swept = await sweepOutbox(db, now);
  s.purged = await purgeLocations(db, now);

  if (deps.line && deps.liffId && !inQuietHours(now)) {
    s.reaped = await reapExpiredLeases(db, now);
    const owner = deps.owner ?? crypto.randomUUID();
    const rows = await claim(db, owner, now, deps.batchSize ?? config.batchSize);
    s.claimed = rows.length;
    for (const row of rows) {
      const outcome = await processRow(deps, deps.line, deps.liffId, owner, row);
      if (outcome) s[outcome]++;
    }
  }

  await db.prepare(
    `INSERT INTO scheduler_heartbeat (id, last_run_at, last_summary) VALUES (1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET last_run_at = excluded.last_run_at, last_summary = excluded.last_summary`,
  ).bind(now, JSON.stringify(s)).run();
  return s;
}

/* ---------------------------------------------------------------- planning */

/**
 * One outbox row per message, created once (dedupe_key is UNIQUE, INSERT OR IGNORE), for PENDING duties on
 * today's and tomorrow's Bangkok calendar date. A row whose send time (after quiet hours) is already past its
 * deadline is created SUPPRESSED, so it shows up as "not sent" instead of going out late.
 */
export async function planOutbox(db: D1Database, now: number): Promise<number> {
  const today = bangkokDateOf(now);
  const { results } = await db.prepare(
    `SELECT d.id, d.member_id, d.duty_date, d.start_at, d.end_at FROM duties d
     WHERE d.status = 'PENDING' AND d.duty_date IN (?, ?)
       AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.dedupe_key = 'M:' || d.id)`,
  ).bind(today, addDays(today, 1)).all<{ id: number; member_id: number; duty_date: string; start_at: number; end_at: number }>();
  if (!results.length) return 0;

  const stmts: D1PreparedStatement[] = [];
  const add = (kind: MessageKind, key: string, memberId: number, date: string, dutyId: number | null, due: number, deadline: number) => {
    const at = afterQuietHours(Math.max(due, now));
    const ok = at < deadline;
    stmts.push(db.prepare(
      `INSERT OR IGNORE INTO outbox (kind, dedupe_key, member_id, duty_date, duty_id, status, due_at, deadline_at, next_attempt_at,
                                     last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(kind, key, memberId, date, dutyId, ok ? "QUEUED" : "SUPPRESSED", due, deadline, at, ok ? null : "too_late_to_send", now, now));
  };

  // One reminder per member per date; its deadline is that member's first start of the day.
  const firstStart = new Map<string, number>();
  for (const d of results) {
    const k = `${d.member_id}|${d.duty_date}`;
    firstStart.set(k, Math.min(firstStart.get(k) ?? Infinity, d.start_at));
  }
  for (const d of results) {
    const k = `${d.member_id}|${d.duty_date}`;
    if (firstStart.get(k) === d.start_at) {
      add("REMINDER", `R:${d.member_id}:${d.duty_date}`, d.member_id, d.duty_date, null,
        bangkokInstant(d.duty_date, config.reminderTime, -1), d.start_at);
    }
    add("PROMPT", `P:${d.id}`, d.member_id, d.duty_date, d.id, d.start_at, d.end_at);
    // Planned last: its presence is what the probe above checks.
    add("MISSED", `M:${d.id}`, d.member_id, d.duty_date, d.id, d.start_at + config.missedAfterMinutes * MIN, d.end_at);
  }
  await db.batch(stmts);
  return results.length;
}

/** A PENDING duty whose window closed is MISSED. */
async function markMissed(db: D1Database, now: number): Promise<number> {
  const r = await db.prepare("UPDATE duties SET status = 'MISSED', updated_at = ? WHERE status = 'PENDING' AND end_at <= ?")
    .bind(now, now).run();
  return r.meta.changes ?? 0;
}

/**
 * Bulk housekeeping for rows that are waiting: suppress messages that are no longer wanted, cancel those whose
 * duty was cancelled, and fail rows past their deadline (visible, never sent late). processRow re-checks anyway.
 */
async function sweepOutbox(db: D1Database, now: number): Promise<number> {
  const waiting = "status IN ('QUEUED', 'RETRY_WAIT')";
  const res = await db.batch([
    db.prepare(`UPDATE outbox SET status = 'CANCELLED', last_error = 'duty_cancelled', updated_at = ?1
                WHERE ${waiting} AND duty_id IN (SELECT id FROM duties WHERE status = 'CANCELLED')`).bind(now),
    db.prepare(`UPDATE outbox SET status = 'CANCELLED', last_error = 'no_pending_duty', updated_at = ?1
                WHERE ${waiting} AND kind = 'REMINDER' AND NOT EXISTS (
                  SELECT 1 FROM duties d WHERE d.member_id = outbox.member_id AND d.duty_date = outbox.duty_date AND d.status = 'PENDING')`).bind(now),
    db.prepare(`UPDATE outbox SET status = 'SUPPRESSED', last_error = 'already_checked_in', updated_at = ?1
                WHERE ${waiting} AND duty_id IN (SELECT id FROM duties WHERE status = 'CHECKED_IN')`).bind(now),
    db.prepare(`UPDATE outbox SET status = 'FAILED', last_error = COALESCE(last_error || '; ', '') || 'deadline_passed', updated_at = ?1
                WHERE ${waiting} AND deadline_at <= ?1`).bind(now),
  ]);
  return res.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

/** Privacy: raw coordinates are kept only for config.locationRetentionDays. */
export async function purgeLocations(db: D1Database, now: number): Promise<number> {
  const r = await db.prepare("UPDATE checkins SET lat = NULL, lng = NULL WHERE submitted_at < ? AND lat IS NOT NULL")
    .bind(now - config.locationRetentionDays * 1440 * MIN).run();
  return r.meta.changes ?? 0;
}

/* ------------------------------------------------------------------ leases */

/** A row whose lease ran out (worker died mid-send) goes back to the queue, keeping its pinned retry key. */
export async function reapExpiredLeases(db: D1Database, now: number): Promise<number> {
  const r = await db.prepare(
    `UPDATE outbox SET status = 'RETRY_WAIT', next_attempt_at = ?1, lease_owner = NULL, lease_until = NULL,
            last_error = 'lease_expired', updated_at = ?1
     WHERE status = 'LEASED' AND lease_until <= ?1`,
  ).bind(now).run();
  return r.meta.changes ?? 0;
}

/** Conditional-UPDATE lease: only rows still QUEUED/RETRY_WAIT are taken, so two owners never share a row. */
export async function claim(db: D1Database, owner: string, now: number, limit: number): Promise<OutboxRow[]> {
  const { results } = await db.prepare(
    `UPDATE outbox SET status = 'LEASED', lease_owner = ?1, lease_until = ?2, updated_at = ?3
     WHERE id IN (SELECT id FROM outbox WHERE status IN ('QUEUED', 'RETRY_WAIT') AND next_attempt_at <= ?3
                  ORDER BY next_attempt_at, id LIMIT ?4)
       AND status IN ('QUEUED', 'RETRY_WAIT')
     RETURNING *`,
  ).bind(owner, now + config.leaseSeconds * 1000, now, limit).all<OutboxRow>();
  return results;
}

/* -------------------------------------------------------------- send a row */

type Outcome = "accepted" | "retried" | "failed" | "suppressed" | "cancelled";

function backoffMs(attempts: number, rand: () => number): number {
  const steps = config.retryBackoffMinutes;
  const base = steps[Math.min(attempts - 1, steps.length - 1)] * MIN;
  return Math.round(base * (1 + (rand() * 2 - 1) * config.retryJitterRatio));
}

interface Ctx { line_user_id: string | null; member_active: number; duties: (DutyInfo & { status: string })[] }

/** What is true NOW for this row: the member, and the duty (PROMPT/MISSED) or that day's duties (REMINDER). */
async function loadCtx(db: D1Database, row: OutboxRow): Promise<Ctx | null> {
  const member = await db.prepare("SELECT line_user_id, active FROM members WHERE id = ?").bind(row.member_id)
    .first<{ line_user_id: string | null; active: number }>();
  if (!member) return null;
  const sql = `SELECT d.shift, d.start_at, d.end_at, d.status, l.name AS location FROM duties d JOIN locations l ON l.id = d.location_id`;
  const { results } = row.duty_id != null
    ? await db.prepare(`${sql} WHERE d.id = ?`).bind(row.duty_id).all<DutyInfo & { status: string }>()
    : await db.prepare(`${sql} WHERE d.member_id = ? AND d.duty_date = ? AND d.status = 'PENDING' ORDER BY d.start_at`)
      .bind(row.member_id, row.duty_date).all<DutyInfo & { status: string }>();
  return { line_user_id: member.line_user_id, member_active: member.active, duties: results };
}

async function processRow(deps: SchedulerDeps, line: LineClient, liffId: string, owner: string, row: OutboxRow): Promise<Outcome | undefined> {
  const { db, clock } = deps;
  const rand = deps.rand ?? Math.random;
  const now = clock.now();

  /** Move a LEASED row to a final/waiting state. The lease guard makes a lost lease a harmless no-op. */
  const finish = async (status: string, error: string | null, next?: number) => {
    await db.prepare(
      `UPDATE outbox SET status = ?, last_error = ?, next_attempt_at = COALESCE(?, next_attempt_at),
              lease_owner = NULL, lease_until = NULL, updated_at = ?
       WHERE id = ? AND status = 'LEASED' AND lease_owner = ?`,
    ).bind(status, error, next ?? null, clock.now(), row.id, owner).run();
  };

  // Re-read before sending: the member may have checked in, or the duty may be gone.
  const ctx = await loadCtx(db, row);
  if (!ctx || !ctx.member_active) { await finish("CANCELLED", "member_inactive"); return "cancelled"; }
  const duty = ctx.duties[0];
  if (!duty || duty.status === "CANCELLED") { await finish("CANCELLED", row.duty_id ? "duty_cancelled" : "no_pending_duty"); return "cancelled"; }
  if (duty.status === "CHECKED_IN") { await finish("SUPPRESSED", "already_checked_in"); return "suppressed"; }
  if (duty.status !== "PENDING" || now >= row.deadline_at) { await finish("FAILED", "deadline_passed"); return "failed"; }
  if (row.attempts >= config.maxAttempts) { await finish("FAILED", "max_attempts"); return "failed"; }

  const target = row.target_user_id ?? ctx.line_user_id;
  if (!target) {
    const next = now + config.unboundRecheckMinutes * MIN;
    if (next >= row.deadline_at) { await finish("FAILED", "not_linked"); return "failed"; }
    await finish("RETRY_WAIT", "not_linked", next);
    return "retried";
  }

  // Pin target + payload + retry key BEFORE the first attempt; COALESCE keeps the first values on retries.
  const payload = row.payload ?? JSON.stringify(buildMessages(row.kind, row.duty_date, ctx.duties, liffId));
  const pinned = await db.prepare(
    `UPDATE outbox SET target_user_id = COALESCE(target_user_id, ?), payload = COALESCE(payload, ?),
            retry_key = COALESCE(retry_key, ?), attempts = attempts + 1, updated_at = ?
     WHERE id = ? AND status = 'LEASED' AND lease_owner = ?
     RETURNING target_user_id, payload, retry_key, attempts`,
  ).bind(target, payload, crypto.randomUUID(), now, row.id, owner)
    .first<{ target_user_id: string; payload: string; retry_key: string; attempts: number }>();
  if (!pinned) return undefined; // lease lost

  let result: PushResult;
  try {
    result = await line.push({ to: pinned.target_user_id, messages: JSON.parse(pinned.payload), retryKey: pinned.retry_key });
  } catch {
    result = { kind: "timeout" };
  }

  const accept = async (requestId: string): Promise<Outcome> => {
    const at = clock.now();
    await db.prepare(
      `UPDATE outbox SET status = 'API_ACCEPTED', accepted_at = ?, line_request_id = ?, last_error = NULL,
              lease_owner = NULL, lease_until = NULL, updated_at = ?
       WHERE id = ? AND status = 'LEASED' AND lease_owner = ?`,
    ).bind(at, requestId, at, row.id, owner).run();
    return "accepted";
  };

  const retryLater = async (delayMs: number, error: string): Promise<Outcome> => {
    const next = afterQuietHours(clock.now() + delayMs);
    if (pinned.attempts >= config.maxAttempts) { await finish("FAILED", `max_attempts: ${error}`); return "failed"; }
    if (next >= row.deadline_at) { await finish("FAILED", `deadline_passed: ${error}`); return "failed"; }
    await finish("RETRY_WAIT", error, next);
    return "retried";
  };

  switch (result.kind) {
    case "accepted":
      await deps.hooks?.afterApiAccepted?.(row);
      return accept(result.requestId);
    case "duplicate": {
      // 409: the key was accepted before. Only believe it if we can name the accepted request.
      const id = result.acceptedRequestId ?? row.line_request_id;
      if (!id) { await finish("FAILED", "duplicate_retry_key_without_accepted_request_id"); return "failed"; }
      return accept(id);
    }
    case "rate_limited":
      return retryLater(result.retryAfterSeconds != null ? result.retryAfterSeconds * 1000 : backoffMs(pinned.attempts, rand), "rate_limited");
    case "server_error":
      return retryLater(backoffMs(pinned.attempts, rand), `server_error_${result.status}`);
    case "timeout":
      return retryLater(backoffMs(pinned.attempts, rand), "timeout");
    case "client_error":
      await finish("FAILED", `http_${result.status}: ${result.message}`);
      return "failed";
  }
}
