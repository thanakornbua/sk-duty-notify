import { describe, it, expect, beforeEach } from "vitest";
import { FixedClock } from "../src/clock";
import { config } from "../src/config";
import { FakeLineClient } from "../src/line-fake";
import { claimJobs, reapExpiredLeases, runScheduler, type Summary } from "../src/scheduler";
import { D, MIN, TABLES, at, db, seed } from "./helpers";

let clock: FixedClock;
let line: FakeLineClient;

beforeEach(async () => {
  for (const t of TABLES) await db.prepare(`DELETE FROM ${t}`).run();
  clock = new FixedClock(0);
  line = new FakeLineClient();
});

/** One scheduler run. rand=0.5 makes the retry jitter exactly zero. */
const tick = (extra: Partial<Parameters<typeof runScheduler>[0]> = {}): Promise<Summary> =>
  runScheduler({ db, clock, line, owner: "w1", rand: () => 0.5, ...extra });

/** Repeat until nothing is claimed (the batch size caps one run). */
async function drain() {
  for (let i = 0; i < 20; i++) if ((await tick()).claimed === 0) return;
  throw new Error("scheduler never went idle");
}

const jobs = async (where = "1=1") =>
  (await db.prepare(`SELECT * FROM notification_jobs WHERE ${where} ORDER BY id`).all<any>()).results;
const count = async (kind: string, phase: string, status: string) =>
  (await db.prepare("SELECT COUNT(*) n FROM notification_jobs WHERE action_kind=? AND phase=? AND status=?").bind(kind, phase, status).first<{ n: number }>())!.n;
const complete = (kind: string) =>
  db.prepare("UPDATE action_states SET state='COMPLETED', outcome='on_time', completed_at=? WHERE action_kind=? AND state='PENDING'").bind(clock.now(), kind).run();
const postbackKind = (m: any) => m.template?.actions?.[0]?.label as string | undefined;

describe("time model", () => {
  it("midnight-UTC edge: AM for 03-01 goes out at 23:30 UTC on 02-28, keyed to the Bangkok date", async () => {
    await seed([D]);
    clock.set(Date.UTC(2026, 1, 28, 9, 0)); // 16:00 Bangkok 02-28
    await drain();
    expect(line.sent).toHaveLength(10); // ACK only
    await complete("ACK");

    const am = await db.prepare("SELECT opens_at, cutoff_at FROM action_states WHERE action_kind='AM' LIMIT 1").first<any>();
    expect(am.opens_at).toBe(Date.UTC(2026, 1, 28, 23, 30));
    expect(am.cutoff_at).toBe(Date.UTC(2026, 2, 1, 5, 0)); // 12:00 Bangkok

    clock.set(Date.UTC(2026, 1, 28, 23, 29));
    await drain();
    expect(line.sent).toHaveLength(10); // nothing yet, although UTC date is still 02-28
    clock.set(Date.UTC(2026, 1, 28, 23, 30));
    await drain();
    expect(line.sent).toHaveLength(20);
    expect(line.sent.slice(10).every((s) => postbackKind(s.messages[0]) === "Check-In AM")).toBe(true);
    const dates = await db.prepare("SELECT DISTINCT a.duty_date d FROM action_states s JOIN assignments a ON a.id=s.assignment_id").all<any>();
    expect(dates.results.map((r: any) => r.d)).toEqual([D]);
  });

  for (const [duty, ackUtc] of [
    ["2026-03-01", Date.UTC(2026, 1, 28, 9)],
    ["2027-01-01", Date.UTC(2026, 11, 31, 9)],
    ["2028-03-01", Date.UTC(2028, 1, 29, 9)],
  ] as const) {
    it(`month/year/leap rollover: ACK for ${duty} is sent at ${new Date(ackUtc).toISOString()}`, async () => {
      await seed([duty]);
      clock.set(ackUtc - MIN);
      await drain();
      expect(line.sent).toHaveLength(0);
      clock.set(ackUtc);
      await drain();
      expect(line.sent).toHaveLength(10);
      expect(line.sent[0].messages[0]).toMatchObject({ type: "text" });
      expect((line.sent[0].messages[0] as any).text).toContain(duty);
    });
  }

  it("ACK is sent the day before a duty day even when that day is a holiday (NO_DUTY) or unknown", async () => {
    await seed(["2026-03-02"], ["2026-03-01"]); // 03-01 explicit NO_DUTY; same logic when the row is absent
    clock.set(at("2026-03-01", "16:00"));
    await drain();
    expect(line.sent).toHaveLength(10);
    expect(await count("ACK", "INITIAL", "API_ACCEPTED")).toBe(10);
  });
});

describe("reminders", () => {
  it("accepted 3 minutes late: the reminder is at accepted + 30, not at scheduled + 30", async () => {
    await seed([D]);
    clock.set(at(D, "06:33")); // scheduler was down at 06:30
    await drain();
    expect(await count("ACK", "INITIAL", "API_ACCEPTED")).toBe(0); // ACK cutoff 06:30 passed: expired, never sent
    const ack = await db.prepare("SELECT state FROM action_states WHERE action_kind='ACK' LIMIT 1").first<any>();
    expect(ack.state).toBe("EXPIRED");
    expect(await jobs("action_kind='ACK'")).toHaveLength(0);

    expect(await count("AM", "INITIAL", "API_ACCEPTED")).toBe(10);
    const rem = await jobs("action_kind='AM' AND phase='REMINDER'");
    expect(rem).toHaveLength(10);
    expect(rem[0].next_attempt_at).toBe(at(D, "07:03"));

    clock.set(at(D, "07:00"));
    await drain();
    expect(await count("AM", "REMINDER", "API_ACCEPTED")).toBe(0);
    clock.set(at(D, "07:03"));
    await drain();
    expect(await count("AM", "REMINDER", "API_ACCEPTED")).toBe(10);
  });

  it("AM done but PM not: only a PM reminder goes out, and never a second one", async () => {
    await seed([D]);
    clock.set(at(D, "06:30"));
    await drain();
    await complete("AM");
    clock.set(at(D, "07:00"));
    await drain();
    expect(await count("AM", "REMINDER", "SUPPRESSED")).toBe(10);
    expect(line.sent).toHaveLength(10); // just the AM initial pushes

    clock.set(at(D, "14:20"));
    await drain();
    expect(await count("PM", "INITIAL", "API_ACCEPTED")).toBe(10);
    clock.set(at(D, "14:50"));
    await drain();
    expect(await count("PM", "REMINDER", "API_ACCEPTED")).toBe(10);
    expect(line.sent).toHaveLength(30);

    clock.set(at(D, "17:00")); // far later: nothing repeats
    await drain();
    expect(line.sent).toHaveLength(30);
    expect(await jobs("phase='REMINDER' AND status='API_ACCEPTED'")).toHaveLength(10);
  });

  it("ACK done: no ACK reminder, but AM and PM are still sent and reminded", async () => {
    await seed([D]);
    clock.set(at(D, "16:00", -1));
    await drain();
    await complete("ACK");
    clock.set(at(D, "16:30", -1));
    await drain();
    expect(await count("ACK", "REMINDER", "SUPPRESSED")).toBe(10);
    expect(line.sent).toHaveLength(10);

    clock.set(at(D, "06:30"));
    await drain();
    clock.set(at(D, "07:00"));
    await drain();
    expect(await count("AM", "INITIAL", "API_ACCEPTED")).toBe(10);
    expect(await count("AM", "REMINDER", "API_ACCEPTED")).toBe(10);
    clock.set(at(D, "14:20"));
    await drain();
    expect(await count("PM", "INITIAL", "API_ACCEPTED")).toBe(10);
  });
});

describe("deadlines", () => {
  it("an expired action is marked EXPIRED and never sent late", async () => {
    await seed([D]);
    clock.set(at(D, "05:00"));
    await tick({ line: undefined }); // plan only, nothing sent; AM job now queued for 06:30
    clock.set(at(D, "12:05")); // the scheduler comes back after the AM cutoff
    await drain();
    expect(line.sent).toHaveLength(0);
    const am = await db.prepare("SELECT state FROM action_states WHERE action_kind='AM' LIMIT 1").first<any>();
    expect(am.state).toBe("EXPIRED");
    const j = await jobs("action_kind='AM'");
    expect(j.every((x: any) => x.status === "FAILED" && x.last_error === "deadline_passed")).toBe(true);
  });

  it("a down scheduler that returns inside the window still sends", async () => {
    await seed([D]);
    clock.set(at(D, "05:00"));
    await tick({ line: undefined });
    clock.set(at(D, "09:00"));
    await drain();
    expect(await count("AM", "INITIAL", "API_ACCEPTED")).toBe(10);
  });
});

describe("outbox: crash and recovery", () => {
  it("crash after LINE accepted but before the DB write: recovers with the same retry key, no second message", async () => {
    await seed([D]);
    clock.set(at(D, "06:30"));
    await expect(tick({ batchSize: 1, hooks: { afterApiAccepted: () => { throw new Error("worker died"); } } })).rejects.toThrow("worker died");
    expect(line.sent).toHaveLength(1);
    const [stuck] = await jobs("status='LEASED'");
    expect(stuck.retry_key).toBe(line.sent[0].retryKey);
    expect(stuck.api_accepted_at).toBeNull(); // the DB never learned it was accepted

    clock.advance(config.leaseSeconds * 1000 + 1000);
    const s = await tick();
    expect(s.reaped).toBe(1);
    const retries = line.calls.filter((c) => c.retryKey === stuck.retry_key);
    expect(retries).toHaveLength(2); // the original attempt and the retry, same key
    expect(line.sent.filter((m) => m.retryKey === stuck.retry_key)).toHaveLength(1); // LINE answered 409: no duplicate message
    expect(line.sent).toHaveLength(10); // the 9 other people, once each, plus the recovered one
    const [recovered] = await jobs(`id=${stuck.id}`);
    expect(recovered.status).toBe("API_ACCEPTED");
    expect(recovered.line_request_id).toBe(line.sent[0].requestId);
    expect(await jobs(`phase='REMINDER' AND assignment_id=${stuck.assignment_id} AND action_kind='${stuck.action_kind}'`)).toHaveLength(1);
  });

  it("a live lease is exclusive; an expired one is reclaimed", async () => {
    await seed([D]);
    clock.set(at(D, "06:30"));
    await tick({ line: undefined });
    const a = await claimJobs(db, "A", clock.now(), 10);
    const b = await claimJobs(db, "B", clock.now(), 10);
    expect(a.length).toBeGreaterThan(0);
    expect(b).toHaveLength(0);
    clock.advance(config.leaseSeconds * 1000);
    expect(await reapExpiredLeases(db, clock.now())).toBe(a.length);
    expect((await claimJobs(db, "B", clock.now(), 10)).length).toBe(a.length);
  });

  it("claims at most batchSize jobs per run", async () => {
    await seed([D]);
    clock.set(at(D, "06:30"));
    expect((await tick({ batchSize: 3 })).claimed).toBe(3);
    expect(line.sent).toHaveLength(3);
    expect((await tick({ batchSize: 3 })).claimed).toBe(3);
  });

  it("planning is idempotent", async () => {
    await seed([D]);
    clock.set(at(D, "05:00"));
    await tick({ line: undefined });
    await tick({ line: undefined });
    expect((await db.prepare("SELECT COUNT(*) n FROM action_states").first<any>()).n).toBe(30);
    expect((await db.prepare("SELECT COUNT(*) n FROM notification_jobs").first<any>()).n).toBeGreaterThan(0);
    const first = (await jobs()).length;
    await tick({ line: undefined });
    expect((await jobs()).length).toBe(first);
  });

  it("writes a heartbeat every run", async () => {
    await seed([D]);
    clock.set(at(D, "05:00"));
    await tick();
    const hb = await db.prepare("SELECT last_run_at FROM scheduler_heartbeat WHERE id=1").first<any>();
    expect(hb.last_run_at).toBe(clock.now());
  });
});

describe("retry policy", () => {
  const first = async () => (await jobs("action_kind='AM' AND phase='INITIAL'"))[0];

  it("5xx: retry in ~1 min with the same retry key, then succeed", async () => {
    await seed([D]);
    clock.set(at(D, "06:30"));
    line.inject({ kind: "server_error", status: 503 });
    await drain();
    const failed = line.calls[0];
    const j = await first();
    expect(j.status).toBe("RETRY_WAIT");
    expect(j.next_attempt_at).toBe(at(D, "06:31"));
    expect(j.attempts).toBe(1);
    clock.set(at(D, "06:31"));
    await drain();
    expect(line.calls.at(-1)!.retryKey).toBe(failed.retryKey);
    expect((await first()).status).toBe("API_ACCEPTED");
    expect(line.sent).toHaveLength(10);
  });

  it("429 respects Retry-After", async () => {
    await seed([D]);
    clock.set(at(D, "06:30"));
    line.inject({ kind: "rate_limited", retryAfterSeconds: 150 });
    await drain();
    expect((await first()).next_attempt_at).toBe(at(D, "06:30") + 150_000);
  });

  it("timeout where LINE did accept: the retry gets 409 + accepted id, still one message", async () => {
    await seed([D]);
    clock.set(at(D, "06:30"));
    line.inject({ kind: "timeout_after_accept" });
    await drain();
    expect((await first()).status).toBe("RETRY_WAIT");
    clock.set(at(D, "06:31"));
    await drain();
    expect((await first()).status).toBe("API_ACCEPTED");
    expect(line.sent).toHaveLength(10);
  });

  it("4xx is terminal and visible; nothing retries", async () => {
    await seed([D]);
    clock.set(at(D, "06:30"));
    line.inject({ kind: "client_error", status: 400, message: "invalid user" });
    await drain();
    const j = await first();
    expect(j.status).toBe("FAILED");
    expect(j.last_error).toContain("http_400");
    const calls = line.calls.length;
    clock.set(at(D, "09:00"));
    await drain();
    expect(line.calls.filter((c) => c.retryKey === j.retry_key)).toHaveLength(1);
    expect(line.calls.length).toBeGreaterThanOrEqual(calls);
  });

  it("409 with no accepted request id anywhere is FAILED, not assumed accepted", async () => {
    await seed([D]);
    clock.set(at(D, "06:30"));
    line.inject({ kind: "conflict" });
    await drain();
    const j = await first();
    expect(j.status).toBe("FAILED");
    expect(j.last_error).toContain("without_accepted_request_id");
  });

  it("gives up after maxAttempts (1, 2, 5, 10 min backoff) with a visible error", async () => {
    await seed([D]);
    clock.set(at(D, "06:30"));
    line.rule = (r) => (r.to === "U001" ? { kind: "server_error" } : undefined);
    const steps = [0, 1, 2, 5, 10];
    for (const m of steps) { clock.advance(m * MIN); await drain(); }
    const j = (await jobs("action_kind='AM' AND phase='INITIAL' AND target_line_user_id='U001'"))[0];
    expect(j.status).toBe("FAILED");
    expect(j.attempts).toBe(config.maxAttempts);
    expect(j.last_error).toContain("max_attempts");
    expect(new Set(line.calls.filter((c) => c.to === "U001" && postbackKind(c.messages[0]) === "Check-In AM").map((c) => c.retryKey)).size).toBe(1);
  });

  it("a retry that would land after the deadline fails instead", async () => {
    await seed([D]);
    clock.set(at(D, "11:59"));
    await tick({ line: undefined });
    line.rule = (r) => (r.to === "U001" ? { kind: "timeout" } : undefined);
    await drain();
    const j = (await jobs("action_kind='AM' AND phase='INITIAL' AND target_line_user_id='U001'"))[0];
    expect(j.status).toBe("FAILED");
    expect(j.last_error).toContain("deadline_passed");
  });
});

describe("guards", () => {
  it("a withdrawn assignment is cancelled, before send and for a pending reminder", async () => {
    await seed([D]);
    clock.set(at(D, "16:00", -1) - MIN);
    await tick({ line: undefined });
    await db.prepare("UPDATE assignments SET is_active=0 WHERE staff_id='S003'").run();
    clock.set(at(D, "16:00", -1));
    await drain();
    expect(line.sent).toHaveLength(9);
    expect(line.sent.some((s) => s.to === "U003")).toBe(false);

    await db.prepare("UPDATE assignments SET withdrawn=1 WHERE staff_id='S004'").run();
    clock.set(at(D, "16:30", -1));
    await drain();
    const s4 = await jobs("phase='REMINDER' AND assignment_id=(SELECT id FROM assignments WHERE staff_id='S004')");
    expect(s4[0].status).toBe("CANCELLED");
    expect(line.sent).toHaveLength(9 + 8); // reminders for the 8 still-assigned, none for S003/S004
    expect(line.sent.filter((s) => s.to === "U004")).toHaveLength(1); // only its initial ACK
  });

  it("an unbound recipient is rechecked, not failed, and is sent once bound", async () => {
    await seed([D], [], { unbound: [2] });
    clock.set(at(D, "06:30"));
    await drain();
    expect(line.sent).toHaveLength(9);
    const j = (await jobs("last_error='unbound'"))[0];
    expect(j.status).toBe("RETRY_WAIT");
    await db.prepare("UPDATE people SET line_user_id='U002' WHERE staff_id='S002'").run();
    clock.set(at(D, "06:36"));
    await drain();
    expect(line.sent.some((s) => s.to === "U002")).toBe(true);
  });

  it("pins the target user: re-binding after the first attempt does not redirect a retry", async () => {
    await seed([D]);
    clock.set(at(D, "06:30"));
    line.rule = (r) => (r.to === "U001" ? { kind: "server_error" } : undefined);
    await tick({ batchSize: 1 });
    await db.prepare("UPDATE people SET line_user_id='UZZZ' WHERE staff_id='S001'").run();
    line.rule = undefined;
    clock.set(at(D, "06:31"));
    await drain();
    expect(line.sent.some((s) => s.to === "UZZZ")).toBe(false);
    expect(line.sent.some((s) => s.to === "U001")).toBe(true);
  });

  it("button payloads carry only action id + revision", async () => {
    await seed([D]);
    clock.set(at(D, "06:30"));
    await drain();
    const m = line.sent[0].messages[0] as any;
    expect(m.template.actions[0].data).toMatch(/^a=\d+&r=\d+$/);
  });
});
