import { env } from "cloudflare:workers";
import { config } from "../src/config";
import { bangkokInstant } from "../src/time";

export const db = env.DB;
export const MIN = 60_000;
export const TABLES = ["scheduler_heartbeat", "audit_log", "webhook_events", "notification_jobs", "action_states",
                "assignments", "roster_days", "roster_revisions", "binding_codes", "people"];
export const D = "2026-03-01"; // default duty date

export const at = (date: string, hhmm: string, dayOffset = 0) => bangkokInstant(date, hhmm, dayOffset);
export const sid = (n: number) => `S${String(n).padStart(3, "0")}`;

/** Active revision with the given DUTY dates (same 10 people each day) and optional explicit NO_DUTY dates. */
export async function seed(duty: string[], noDuty: string[] = [], opts: { unbound?: number[] } = {}) {
  const stmts = [];
  for (let i = 1; i <= 10; i++) {
    stmts.push(db.prepare("INSERT INTO people (staff_id, label, line_user_id) VALUES (?, ?, ?)")
      .bind(sid(i), `Person ${i}`, opts.unbound?.includes(i) ? null : `U${String(i).padStart(3, "0")}`));
  }
  stmts.push(db.prepare("INSERT INTO roster_revisions (id, content_hash, status, created_at) VALUES (1, 'h', 'ACTIVE', 0)"));
  for (const d of duty) {
    stmts.push(db.prepare("INSERT INTO roster_days (revision_id, duty_date, state) VALUES (1, ?, 'DUTY')").bind(d));
    for (let i = 1; i <= 10; i++) {
      stmts.push(db.prepare("INSERT INTO assignments (revision_id, duty_date, position, staff_id, is_active) VALUES (1, ?, ?, ?, 1)")
        .bind(d, config.positions[i - 1], sid(i)));
    }
  }
  for (const d of noDuty) stmts.push(db.prepare("INSERT INTO roster_days (revision_id, duty_date, state) VALUES (1, ?, 'NO_DUTY')").bind(d));
  await db.batch(stmts);
}

