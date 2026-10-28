import { env } from "cloudflare:workers";
import { describe, it, expect, beforeEach } from "vitest";

const db = env.DB;
const T = 1_700_000_000_000;

async function run(sql: string, ...binds: unknown[]) {
  return db.prepare(sql).bind(...binds).run();
}
async function rejects(sql: string, ...binds: unknown[]) {
  await expect(run(sql, ...binds)).rejects.toThrow(/constraint|CHECK|UNIQUE|FOREIGN/i);
}

async function addPerson(id: string, lineUser: string | null = null) {
  await run("INSERT INTO people (staff_id, label, line_user_id) VALUES (?, ?, ?)", id, `Person ${id}`, lineUser);
}
async function addRevision(id: number, hash: string, status = "ACTIVE") {
  await run("INSERT INTO roster_revisions (id, content_hash, status, created_at) VALUES (?, ?, ?, ?)", id, hash, status, T);
}
async function addAssignment(id: number, rev: number, date: string, pos: string, staff: string, active = 1) {
  await run(
    "INSERT INTO assignments (id, revision_id, duty_date, position, staff_id, is_active) VALUES (?, ?, ?, ?, ?, ?)",
    id, rev, date, pos, staff, active,
  );
}
async function addAction(id: number, assignment: number, kind: string) {
  await run(
    "INSERT INTO action_states (id, assignment_id, action_kind, opens_at, late_after_at, cutoff_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    id, assignment, kind, T, T + 1, T + 2, T,
  );
}
async function addJob(id: number, assignment: number, kind: string, phase: string, revision = 1) {
  await run(
    "INSERT INTO notification_jobs (id, assignment_id, action_kind, phase, revision, next_attempt_at, deadline_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id, assignment, kind, phase, revision, T, T + 10, T, T,
  );
}

beforeEach(async () => {
  // D1 in the test pool does not isolate storage per test; clear in FK order.
  for (const t of ["audit_log", "webhook_events", "notification_jobs", "action_states",
                   "assignments", "roster_days", "roster_revisions", "people"]) {
    await run(`DELETE FROM ${t}`);
  }
  await addPerson("S001");
  await addPerson("S002");
  await addRevision(1, "hash-1");
});

describe("schema", () => {
  it("applies all migrations (every table exists)", async () => {
    const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{ name: string }>();
    const names = results.map((r: { name: string }) => r.name);
    for (const t of ["people", "roster_revisions", "roster_days", "assignments", "action_states",
                     "notification_jobs", "webhook_events", "audit_log"]) {
      expect(names).toContain(t);
    }
  });

  it("rejects duplicate (date, position) in the active revision", async () => {
    await addAssignment(1, 1, "2026-03-01", "P1", "S001");
    await rejects(
      "INSERT INTO assignments (id, revision_id, duty_date, position, staff_id, is_active) VALUES (2, 1, '2026-03-01', 'P1', 'S002', 1)",
    );
  });

  it("rejects the same staff twice on one date in the active revision", async () => {
    await addAssignment(1, 1, "2026-03-01", "P1", "S001");
    await rejects(
      "INSERT INTO assignments (id, revision_id, duty_date, position, staff_id, is_active) VALUES (2, 1, '2026-03-01', 'P2', 'S001', 1)",
    );
  });

  it("allows the same (date, position) in an inactive revision", async () => {
    await addAssignment(1, 1, "2026-03-01", "P1", "S001");
    await addRevision(2, "hash-2", "STAGED");
    await addAssignment(2, 2, "2026-03-01", "P1", "S002", 0);
  });

  it("rejects an unknown staff id (foreign key)", async () => {
    await rejects(
      "INSERT INTO assignments (id, revision_id, duty_date, position, staff_id, is_active) VALUES (1, 1, '2026-03-01', 'P1', 'NOPE', 1)",
    );
  });

  it("rejects a malformed duty date", async () => {
    await rejects(
      "INSERT INTO assignments (id, revision_id, duty_date, position, staff_id) VALUES (1, 1, '01/03/2026', 'P1', 'S001')",
    );
  });

  it("rejects a second ACTIVE revision and a duplicate content hash", async () => {
    await rejects("INSERT INTO roster_revisions (id, content_hash, status, created_at) VALUES (2, 'hash-2', 'ACTIVE', 0)");
    await rejects("INSERT INTO roster_revisions (id, content_hash, status, created_at) VALUES (3, 'hash-1', 'STAGED', 0)");
  });

  it("rejects duplicate (revision, date) in roster_days and bad day state", async () => {
    await run("INSERT INTO roster_days (revision_id, duty_date, state) VALUES (1, '2026-03-01', 'DUTY')");
    await rejects("INSERT INTO roster_days (revision_id, duty_date, state) VALUES (1, '2026-03-01', 'NO_DUTY')");
    await rejects("INSERT INTO roster_days (revision_id, duty_date, state) VALUES (1, '2026-03-02', 'HOLIDAY')");
  });

  it("rejects duplicate (assignment, action_kind) in action_states", async () => {
    await addAssignment(1, 1, "2026-03-01", "P1", "S001");
    await addAction(1, 1, "ACK");
    await addAction(2, 1, "AM"); // independent kinds are fine
    await rejects(
      "INSERT INTO action_states (id, assignment_id, action_kind, opens_at, late_after_at, cutoff_at, updated_at) VALUES (3, 1, 'ACK', 0, 0, 0, 0)",
    );
  });

  it("keeps action state and outcome consistent", async () => {
    await addAssignment(1, 1, "2026-03-01", "P1", "S001");
    await addAction(1, 1, "AM");
    await rejects("UPDATE action_states SET state = 'COMPLETED' WHERE id = 1"); // no outcome / completed_at
    await rejects("UPDATE action_states SET state = 'DELIVERED' WHERE id = 1");
    await run("UPDATE action_states SET state='COMPLETED', outcome='late', completed_at=? WHERE id=1", T);
  });

  it("rejects duplicate (assignment, kind, phase, revision) in jobs, allows a new revision", async () => {
    await addAssignment(1, 1, "2026-03-01", "P1", "S001");
    await addJob(1, 1, "AM", "INITIAL");
    await addJob(2, 1, "AM", "REMINDER"); // different phase
    await addJob(3, 1, "AM", "INITIAL", 2); // different revision
    await rejects(
      "INSERT INTO notification_jobs (id, assignment_id, action_kind, phase, revision, next_attempt_at, deadline_at, created_at, updated_at) VALUES (4, 1, 'AM', 'INITIAL', 1, 0, 0, 0, 0)",
    );
  });

  it("has no 'delivered' job state and ties api_accepted_at to API_ACCEPTED", async () => {
    await addAssignment(1, 1, "2026-03-01", "P1", "S001");
    await addJob(1, 1, "AM", "INITIAL");
    await rejects("UPDATE notification_jobs SET status = 'DELIVERED' WHERE id = 1");
    await rejects("UPDATE notification_jobs SET status = 'API_ACCEPTED' WHERE id = 1"); // no api_accepted_at
    await run("UPDATE notification_jobs SET status='API_ACCEPTED', api_accepted_at=? WHERE id=1", T);
  });

  it("has the (status, next_attempt_at) index and the due query uses it", async () => {
    const { results } = await db
      .prepare("EXPLAIN QUERY PLAN SELECT id FROM notification_jobs WHERE status = 'QUEUED' AND next_attempt_at <= ? LIMIT 10")
      .bind(T)
      .all<{ detail: string }>();
    expect(results.map((r: { detail: string }) => r.detail).join(" ")).toContain("idx_jobs_due");
  });

  it("rejects a duplicate webhook_event_id", async () => {
    await run("INSERT INTO webhook_events (webhook_event_id, received_at, event_type) VALUES ('E1', ?, 'message')", T);
    await rejects("INSERT INTO webhook_events (webhook_event_id, received_at, event_type) VALUES ('E1', ?, 'message')", T);
  });

  it("allows one staff per LINE user only", async () => {
    await run("UPDATE people SET line_user_id = 'Uaaa' WHERE staff_id = 'S001'");
    await rejects("UPDATE people SET line_user_id = 'Uaaa' WHERE staff_id = 'S002'");
  });
});
