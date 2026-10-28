import type { Clock } from "./clock";
import { config, type ActionKind } from "./config";
import type { LineClient, LineMessage, PushResult } from "./line";
import { buildMessages } from "./messages";
import { addDays, bangkokDateOf, bangkokInstant } from "./time";

const MIN = 60_000;
const KINDS: ActionKind[] = ["ACK", "AM", "PM"];

export interface JobRow {
  id: number;
  assignment_id: number;
  action_kind: ActionKind;
  phase: "INITIAL" | "REMINDER";
  revision: number;
  status: string;
  next_attempt_at: number;
  deadline_at: number;
  attempts: number;
  target_line_user_id: string | null;
  payload: string | null;
  retry_key: string | null;
  line_request_id: string | null;
}

export interface SchedulerDeps {
  db: D1Database;
  clock: Clock;
  /** Omit to plan/expire/heartbeat only (nothing is sent). */
  line?: LineClient;
  owner?: string;
  rand?: () => number;
  batchSize?: number;
  /** Test seam: called right after LINE accepted, before the DB write that records it. */
  hooks?: { afterApiAccepted?: (job: JobRow) => void | Promise<void> };
}

export interface Summary {
  planned: number;
  cancelled: number;
  expired: number;
  reaped: number;
  claimed: number;
  accepted: number;
  retried: number;
  failed: number;
  suppressed: number;
}

export async function runScheduler(deps: SchedulerDeps): Promise<Summary> {
  const { db, clock } = deps;
  const s: Summary = { planned: 0, cancelled: 0, expired: 0, reaped: 0, claimed: 0, accepted: 0, retried: 0, failed: 0, suppressed: 0 };

  s.planned = await planJobs(db, clock.now());
  s.cancelled = await cancelWithdrawn(db, clock.now());
  s.expired = await expireActions(db, clock.now());

  if (deps.line) {
    s.reaped = await reapExpiredLeases(db, clock.now());
    const owner = deps.owner ?? crypto.randomUUID();
    const jobs = await claimJobs(db, owner, clock.now(), deps.batchSize ?? config.batchSize);
    s.claimed = jobs.length;
    for (const job of jobs) {
      const outcome = await processJob(deps, deps.line, owner, job);
      if (outcome) s[outcome]++;
    }
  }

  await db.prepare(
    `INSERT INTO scheduler_heartbeat (id, last_run_at, last_summary) VALUES (1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET last_run_at = excluded.last_run_at, last_summary = excluded.last_summary`,
  ).bind(clock.now(), JSON.stringify(s)).run();
  return s;
}

/* ---------------------------------------------------------------- planning */

/**
 * Create the three action states + INITIAL jobs for active assignments on today's and tomorrow's
 * Bangkok calendar date. Calendar days only: whether today is a duty day is irrelevant.
 * An action whose cutoff already passed is created EXPIRED with no job (never sent late).
 */
export async function planJobs(db: D1Database, now: number): Promise<number> {
  const today = bangkokDateOf(now);
  const { results } = await db.prepare(
    `SELECT a.id, a.duty_date FROM assignments a
     WHERE a.is_active = 1 AND a.withdrawn = 0 AND a.duty_date IN (?, ?)
       AND (SELECT COUNT(*) FROM action_states s WHERE s.assignment_id = a.id) < 3`,
  ).bind(today, addDays(today, 1)).all<{ id: number; duty_date: string }>();
  if (!results.length) return 0;

  const stmts: D1PreparedStatement[] = [];
  for (const a of results) {
    for (const kind of KINDS) {
      const st = config.sendTimes[kind], co = config.cutoffs[kind];
      const opens = bangkokInstant(a.duty_date, st.time, st.dayOffset);
      const cutoff = bangkokInstant(a.duty_date, co.time, co.dayOffset);
      const live = cutoff > now;
      stmts.push(db.prepare(
        `INSERT OR IGNORE INTO action_states (assignment_id, action_kind, state, opens_at, late_after_at, cutoff_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(a.id, kind, live ? "PENDING" : "EXPIRED", opens, opens + config.lateAfterMinutes * MIN, cutoff, now));
      if (live) {
        stmts.push(db.prepare(
          `INSERT OR IGNORE INTO notification_jobs
             (assignment_id, action_kind, phase, revision, status, next_attempt_at, deadline_at, created_at, updated_at)
           VALUES (?, ?, 'INITIAL', 1, 'QUEUED', ?, ?, ?, ?)`,
        ).bind(a.id, kind, opens, cutoff, now, now));
      }
    }
  }
  await db.batch(stmts);
  return results.length;
}

/** Jobs/actions of assignments that left the active roster (superseded or withdrawn) are cancelled. */
async function cancelWithdrawn(db: D1Database, now: number): Promise<number> {
  const gone = "(SELECT id FROM assignments WHERE is_active = 0 OR withdrawn = 1)";
  const [j] = await db.batch([
    db.prepare(`UPDATE notification_jobs SET status = 'CANCELLED', last_error = 'assignment_withdrawn', updated_at = ?
                WHERE status IN ('QUEUED', 'RETRY_WAIT') AND assignment_id IN ${gone}`).bind(now),
    db.prepare(`UPDATE action_states SET state = 'CANCELLED', updated_at = ?
                WHERE state = 'PENDING' AND assignment_id IN ${gone}`).bind(now),
  ]);
  return j.meta.changes ?? 0;
}

async function expireActions(db: D1Database, now: number): Promise<number> {
  const r = await db.prepare(
    "UPDATE action_states SET state = 'EXPIRED', updated_at = ? WHERE state = 'PENDING' AND cutoff_at <= ?",
  ).bind(now, now).run();
  return r.meta.changes ?? 0;
}

/* ------------------------------------------------------------------ leases */

/** A job whose lease ran out (worker died mid-send) goes back to the queue, keeping its pinned retry key. */
export async function reapExpiredLeases(db: D1Database, now: number): Promise<number> {
  const r = await db.prepare(
    `UPDATE notification_jobs SET status = 'RETRY_WAIT', next_attempt_at = ?, lease_owner = NULL, lease_until = NULL,
            last_error = 'lease_expired', updated_at = ?
     WHERE status = 'LEASED' AND lease_until <= ?`,
  ).bind(now, now, now).run();
  return r.meta.changes ?? 0;
}

/** Conditional-UPDATE lease: only rows still QUEUED/RETRY_WAIT are taken, so two owners never share a job. */
export async function claimJobs(db: D1Database, owner: string, now: number, limit: number): Promise<JobRow[]> {
  const { results } = await db.prepare(
    `UPDATE notification_jobs SET status = 'LEASED', lease_owner = ?1, lease_until = ?2, updated_at = ?3
     WHERE id IN (SELECT id FROM notification_jobs
                  WHERE status IN ('QUEUED', 'RETRY_WAIT') AND next_attempt_at <= ?3
                  ORDER BY next_attempt_at, id LIMIT ?4)
       AND status IN ('QUEUED', 'RETRY_WAIT')
     RETURNING *`,
  ).bind(owner, now + config.leaseSeconds * 1000, now, limit).all<JobRow>();
  return results;
}

/* ------------------------------------------------------------- send a job */

type Outcome = "accepted" | "retried" | "failed" | "suppressed" | "cancelled";

interface ActionCtx {
  action_id: number;
  state: string;
  revision: number;
  cutoff_at: number;
  duty_date: string;
  is_active: number;
  withdrawn: number;
  line_user_id: string | null;
}

function backoffMs(attempts: number, rand: () => number): number {
  const steps = config.retryBackoffMinutes;
  const base = steps[Math.min(attempts - 1, steps.length - 1)] * MIN;
  return Math.round(base * (1 + (rand() * 2 - 1) * config.retryJitterRatio));
}

async function processJob(deps: SchedulerDeps, line: LineClient, owner: string, job: JobRow): Promise<Outcome | undefined> {
  const { db, clock } = deps;
  const rand = deps.rand ?? Math.random;
  const now = clock.now();

  /** Move a LEASED job to a final/waiting state. The status guard makes a lost lease a harmless no-op. */
  const finish = async (status: string, error: string | null, extra: { next?: number } = {}) => {
    await db.prepare(
      `UPDATE notification_jobs SET status = ?, last_error = ?, next_attempt_at = COALESCE(?, next_attempt_at),
              lease_owner = NULL, lease_until = NULL, updated_at = ?
       WHERE id = ? AND status = 'LEASED' AND lease_owner = ?`,
    ).bind(status, error, extra.next ?? null, clock.now(), job.id, owner).run();
  };

  // Re-read the action: what mattered when the job was queued may no longer be true.
  const ctx = await db.prepare(
    `SELECT s.id AS action_id, s.state, s.revision, s.cutoff_at, a.duty_date, a.is_active, a.withdrawn, p.line_user_id
     FROM action_states s
     JOIN assignments a ON a.id = s.assignment_id
     JOIN people p ON p.staff_id = a.staff_id
     WHERE s.assignment_id = ? AND s.action_kind = ?`,
  ).bind(job.assignment_id, job.action_kind).first<ActionCtx>();

  if (!ctx) { await finish("FAILED", "action_missing"); return "failed"; }
  if (!ctx.is_active || ctx.withdrawn) {
    await db.prepare("UPDATE action_states SET state = 'CANCELLED', updated_at = ? WHERE id = ? AND state = 'PENDING'")
      .bind(now, ctx.action_id).run();
    await finish("CANCELLED", "assignment_withdrawn");
    return "cancelled";
  }
  if (ctx.state === "COMPLETED") { await finish("SUPPRESSED", "action_completed"); return "suppressed"; }

  const pastDeadline = now >= job.deadline_at;
  if (ctx.state !== "PENDING" || pastDeadline) {
    if (pastDeadline && ctx.state === "PENDING") {
      await db.prepare("UPDATE action_states SET state = 'EXPIRED', updated_at = ? WHERE id = ? AND state = 'PENDING'")
        .bind(now, ctx.action_id).run();
    }
    // A reminder that is no longer wanted is normal; an initial push that never went out is a failure.
    if (job.phase === "REMINDER") { await finish("SUPPRESSED", `action_${ctx.state.toLowerCase()}_or_deadline`); return "suppressed"; }
    await finish("FAILED", "deadline_passed");
    return "failed";
  }
  if (job.attempts >= config.maxAttempts) { await finish("FAILED", "max_attempts"); return "failed"; }

  const target = job.target_line_user_id ?? ctx.line_user_id;
  if (!target) {
    const next = now + config.unboundRecheckMinutes * MIN;
    if (next >= job.deadline_at) { await finish("FAILED", "unbound"); return "failed"; }
    await finish("RETRY_WAIT", "unbound", { next });
    return "retried";
  }

  // Pin target + payload + retry key BEFORE the first attempt; COALESCE keeps the first values on retries.
  const payload = job.payload ?? JSON.stringify(await loadMessages(db, job, ctx));
  const pinned = await db.prepare(
    `UPDATE notification_jobs SET target_line_user_id = COALESCE(target_line_user_id, ?), payload = COALESCE(payload, ?),
            retry_key = COALESCE(retry_key, ?), attempts = attempts + 1, updated_at = ?
     WHERE id = ? AND status = 'LEASED' AND lease_owner = ?
     RETURNING target_line_user_id, payload, retry_key, attempts`,
  ).bind(target, payload, crypto.randomUUID(), now, job.id, owner)
    .first<{ target_line_user_id: string; payload: string; retry_key: string; attempts: number }>();
  if (!pinned) return undefined; // lease lost

  let result: PushResult;
  try {
    result = await line.push({ to: pinned.target_line_user_id, messages: JSON.parse(pinned.payload), retryKey: pinned.retry_key });
  } catch {
    result = { kind: "timeout" };
  }

  const accept = async (requestId: string): Promise<Outcome> => {
    const acceptedAt = clock.now();
    const remindAt = acceptedAt + config.reminderOffsetMinutes * MIN;
    const stmts = [
      db.prepare(
        `UPDATE notification_jobs SET status = 'API_ACCEPTED', api_accepted_at = ?, line_request_id = ?, last_error = NULL,
                lease_owner = NULL, lease_until = NULL, updated_at = ?
         WHERE id = ? AND status = 'LEASED' AND lease_owner = ?`,
      ).bind(acceptedAt, requestId, acceptedAt, job.id, owner),
    ];
    if (job.phase === "INITIAL") {
      // One reminder at accepted + 30 min, only while the action is still PENDING and the cutoff is later.
      stmts.push(db.prepare(
        `INSERT OR IGNORE INTO notification_jobs
           (assignment_id, action_kind, phase, revision, status, next_attempt_at, deadline_at, created_at, updated_at)
         SELECT s.assignment_id, s.action_kind, 'REMINDER', ?, 'QUEUED', ?, s.cutoff_at, ?, ?
         FROM action_states s
         WHERE s.assignment_id = ? AND s.action_kind = ? AND s.state = 'PENDING' AND s.cutoff_at > ?`,
      ).bind(job.revision, remindAt, acceptedAt, acceptedAt, job.assignment_id, job.action_kind, remindAt));
    }
    await db.batch(stmts);
    return "accepted";
  };

  const retryLater = async (delayMs: number, error: string): Promise<Outcome> => {
    const next = clock.now() + delayMs;
    if (pinned.attempts >= config.maxAttempts) { await finish("FAILED", `max_attempts: ${error}`); return "failed"; }
    if (next >= job.deadline_at) { await finish("FAILED", `deadline_passed: ${error}`); return "failed"; }
    await finish("RETRY_WAIT", error, { next });
    return "retried";
  };

  switch (result.kind) {
    case "accepted":
      await deps.hooks?.afterApiAccepted?.(job);
      return accept(result.requestId);
    case "duplicate": {
      // 409: the key was accepted before. Only believe it if we can name the accepted request.
      const id = result.acceptedRequestId ?? job.line_request_id;
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

/* ------------------------------------------------------------ message copy */

async function loadMessages(db: D1Database, job: JobRow, ctx: ActionCtx): Promise<LineMessage[]> {
  let roster: { position: string; label: string }[] = [];
  if (job.action_kind === "ACK" && job.phase === "INITIAL") {
    roster = (await db.prepare(
      `SELECT a.position, p.label FROM assignments a JOIN people p ON p.staff_id = a.staff_id
       WHERE a.duty_date = ? AND a.is_active = 1 AND a.withdrawn = 0 ORDER BY a.position`,
    ).bind(ctx.duty_date).all<{ position: string; label: string }>()).results;
  }
  return buildMessages({ kind: job.action_kind, phase: job.phase, dutyDate: ctx.duty_date, actionId: ctx.action_id, revision: ctx.revision, roster });
}
