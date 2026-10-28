import type { Clock } from "./clock";
import { config, type ActionKind } from "./config";
import { addDays, bangkokDateOf, bangkokInstant } from "./time";

const MIN = 60_000;
const KINDS: ActionKind[] = ["ACK", "AM", "PM"];

interface PushInfo { status: string; acceptedAt: number | null; attempts: number; error: string | null; nextAttemptAt: number }
interface ActionView {
  kind: ActionKind;
  /** What the user did. Never inferred from the push. */
  user: { state: string; outcome: string | null; completedAt: number | null };
  /** What LINE's API did with our push (accepted != delivered != read != acted on). */
  push: { initial: PushInfo | null; reminder: PushInfo | null };
  opensAt: number;
  cutoffAt: number;
}
export interface Alert { severity: "high" | "warn"; code: string; message: string }

export async function buildDashboard(db: D1Database, clock: Clock) {
  const now = clock.now();
  const today = bangkokDateOf(now);
  const tomorrow = addDays(today, 1);
  const dates = [today, tomorrow];
  const alerts: Alert[] = [];

  const active = await db.prepare("SELECT id FROM roster_revisions WHERE status = 'ACTIVE'").first<{ id: number }>();
  if (!active) alerts.push({ severity: "high", code: "no_active_revision", message: "No roster has been published." });

  const [dayRows, asg, acts, jobs] = await Promise.all([
    db.prepare("SELECT duty_date, state FROM roster_days WHERE revision_id = ? AND duty_date IN (?, ?)")
      .bind(active?.id ?? -1, today, tomorrow).all<{ duty_date: string; state: string }>(),
    db.prepare(
      `SELECT a.id, a.duty_date, a.position, a.staff_id, p.label, p.line_user_id IS NOT NULL AS bound
       FROM assignments a JOIN people p ON p.staff_id = a.staff_id
       WHERE a.is_active = 1 AND a.withdrawn = 0 AND a.duty_date IN (?, ?) ORDER BY a.duty_date, a.position`,
    ).bind(today, tomorrow).all<any>(),
    db.prepare(
      `SELECT s.assignment_id, s.action_kind, s.state, s.outcome, s.completed_at, s.opens_at, s.cutoff_at
       FROM action_states s JOIN assignments a ON a.id = s.assignment_id
       WHERE a.is_active = 1 AND a.duty_date IN (?, ?)`,
    ).bind(today, tomorrow).all<any>(),
    db.prepare(
      `SELECT j.assignment_id, j.action_kind, j.phase, j.status, j.api_accepted_at, j.attempts, j.last_error, j.next_attempt_at
       FROM notification_jobs j JOIN assignments a ON a.id = j.assignment_id
       WHERE a.is_active = 1 AND a.duty_date IN (?, ?)`,
    ).bind(today, tomorrow).all<any>(),
  ]);

  const dayState = new Map(dayRows.results.map((d) => [d.duty_date, d.state]));
  const actionBy = new Map(acts.results.map((a: any) => [`${a.assignment_id}:${a.action_kind}`, a]));
  const jobBy = new Map(jobs.results.map((j: any) => [`${j.assignment_id}:${j.action_kind}:${j.phase}`, j]));
  const pushInfo = (j: any): PushInfo | null => j && ({
    status: j.status, acceptedAt: j.api_accepted_at, attempts: j.attempts, error: j.last_error, nextAttemptAt: j.next_attempt_at,
  });

  const days = dates.map((date) => {
    const order = (p: string) => config.positions.indexOf(p as (typeof config.positions)[number]);
    const rows = asg.results.filter((a: any) => a.duty_date === date).sort((a: any, b: any) => order(a.position) - order(b.position)).map((a: any) => ({
      position: a.position, staffId: a.staff_id, label: a.label, bound: !!a.bound,
      actions: KINDS.map((kind): ActionView | null => {
        const s: any = actionBy.get(`${a.id}:${kind}`);
        if (!s) return null; // planned later; nothing exists yet
        return {
          kind,
          user: { state: s.state, outcome: s.outcome, completedAt: s.completed_at },
          push: { initial: pushInfo(jobBy.get(`${a.id}:${kind}:INITIAL`)), reminder: pushInfo(jobBy.get(`${a.id}:${kind}:REMINDER`)) },
          opensAt: s.opens_at, cutoffAt: s.cutoff_at,
        };
      }),
    }));
    // Missing data is UNKNOWN, never "no duty".
    const state = rows.length ? "DUTY" : active ? (dayState.get(date) ?? "UNKNOWN") : "UNKNOWN";
    return { date, state, rows };
  });

  // Missing-roster alerts: only UNKNOWN counts. An explicit NO_DUTY day is information, not a problem.
  for (const d of days) {
    if (d.state !== "UNKNOWN" || !active) continue;
    const high = d.date === today || now >= bangkokInstant(today, config.missingTomorrowHighAfter);
    alerts.push({ severity: high ? "high" : "warn", code: "roster_missing", message: `No roster data for ${d.date}.` });
  }

  // Failed jobs: terminal failures, newest first.
  const failed = await db.prepare(
    `SELECT j.id, j.action_kind, j.phase, j.attempts, j.last_error, j.deadline_at, j.updated_at, a.duty_date, a.staff_id
     FROM notification_jobs j JOIN assignments a ON a.id = j.assignment_id
     WHERE j.status = 'FAILED' ORDER BY j.updated_at DESC, j.id DESC LIMIT ?`,
  ).bind(config.failedJobsLimit).all<any>();
  const failedTotal = (await db.prepare("SELECT COUNT(*) n FROM notification_jobs WHERE status = 'FAILED'").first<{ n: number }>())!.n;
  if (failedTotal) alerts.push({ severity: "high", code: "failed_jobs", message: `${failedTotal} notification job(s) failed and need attention.` });

  // Unbound users: those on duty now cannot be notified at all.
  const unboundDuty = await db.prepare(
    `SELECT DISTINCT p.staff_id, p.label, a.duty_date FROM assignments a JOIN people p ON p.staff_id = a.staff_id
     WHERE a.is_active = 1 AND a.withdrawn = 0 AND a.duty_date IN (?, ?) AND p.line_user_id IS NULL ORDER BY a.duty_date, p.staff_id`,
  ).bind(today, tomorrow).all<any>();
  const pool = await db.prepare(
    "SELECT COUNT(*) total, SUM(line_user_id IS NULL) unbound FROM people WHERE active = 1",
  ).first<{ total: number; unbound: number | null }>();
  if (unboundDuty.results.length) {
    alerts.push({ severity: "high", code: "unbound_on_duty", message: `${new Set(unboundDuty.results.map((u: any) => u.staff_id)).size} person(s) on duty today/tomorrow have no LINE account linked.` });
  }

  // Actions that expired although we never got a push accepted.
  const never = await db.prepare(
    `SELECT COUNT(*) n FROM action_states s JOIN assignments a ON a.id = s.assignment_id
     WHERE a.is_active = 1 AND a.duty_date IN (?, ?) AND s.state = 'EXPIRED'
       AND NOT EXISTS (SELECT 1 FROM notification_jobs j WHERE j.assignment_id = s.assignment_id
                       AND j.action_kind = s.action_kind AND j.phase = 'INITIAL' AND j.status = 'API_ACCEPTED')`,
  ).bind(today, tomorrow).first<{ n: number }>();
  if (never!.n) alerts.push({ severity: "high", code: "never_notified", message: `${never!.n} action(s) expired without any push being accepted.` });

  // Scheduler liveness.
  const hb = await db.prepare("SELECT last_run_at, last_summary FROM scheduler_heartbeat WHERE id = 1").first<{ last_run_at: number; last_summary: string }>();
  const ageMs = hb ? now - hb.last_run_at : null;
  const hbStatus = !hb ? "NEVER" : ageMs! > config.heartbeatStaleMinutes * MIN ? "STALE" : "OK";
  if (hbStatus !== "OK") {
    alerts.push({ severity: "high", code: hbStatus === "NEVER" ? "scheduler_never_ran" : "scheduler_stale",
      message: hbStatus === "NEVER" ? "The scheduler has never run." : `The scheduler last ran ${Math.round(ageMs! / MIN)} min ago.` });
  }

  const overdue = await db.prepare(
    "SELECT COUNT(*) n FROM notification_jobs WHERE status IN ('QUEUED', 'RETRY_WAIT') AND next_attempt_at <= ?",
  ).bind(now - config.overdueQueueMinutes * MIN).first<{ n: number }>();
  if (overdue!.n) alerts.push({ severity: "warn", code: "queue_overdue", message: `${overdue!.n} job(s) are more than ${config.overdueQueueMinutes} min past due.` });

  return {
    now, today, tomorrow,
    alerts,
    days,
    failedJobs: { total: failedTotal, items: failed.results.map((f: any) => ({
      id: f.id, dutyDate: f.duty_date, staffId: f.staff_id, kind: f.action_kind, phase: f.phase,
      attempts: f.attempts, error: f.last_error, deadlineAt: f.deadline_at, updatedAt: f.updated_at,
    })) },
    unbound: { onDuty: unboundDuty.results.map((u: any) => ({ staffId: u.staff_id, label: u.label, dutyDate: u.duty_date })),
      poolUnbound: pool!.unbound ?? 0, poolTotal: pool!.total },
    scheduler: { status: hbStatus, lastRunAt: hb?.last_run_at ?? null, ageSeconds: ageMs === null ? null : Math.round(ageMs / 1000),
      lastSummary: hb ? JSON.parse(hb.last_summary) : null },
  };
}
