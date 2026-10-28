import { env } from "cloudflare:workers";
import { describe, it, expect, beforeEach } from "vitest";
import { handleRequest } from "../src/app";
import { FixedClock } from "../src/clock";
import { FakeLineClient } from "../src/line-fake";
import { runScheduler } from "../src/scheduler";
import dashboardHtml from "../public/dashboard.html?raw";
import { D, MIN, TABLES, at, db, seed } from "./helpers";

let clock: FixedClock;
let line: FakeLineClient;

beforeEach(async () => {
  for (const t of TABLES) await db.prepare(`DELETE FROM ${t}`).run();
  clock = new FixedClock(at(D, "00:00", -1));
  line = new FakeLineClient();
});

const tick = () => runScheduler({ db, clock, line, rand: () => 0.5 });
async function dash(token: string | null = "test-token") {
  const r = await handleRequest(new Request("https://x.test/admin/dashboard.json", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }), env, clock, line);
  return { status: r.status, raw: await r.text() };
}
async function get() {
  const r = await dash();
  expect(r.status).toBe(200);
  return JSON.parse(r.raw);
}
const codes = (d: any) => d.alerts.map((a: any) => a.code);

describe("dashboard", () => {
  it("requires the (stub) admin token", async () => {
    expect((await dash(null)).status).toBe(401);
    expect((await dash("wrong")).status).toBe(401);
  });

  it("shows today/tomorrow with push status and user status kept separate", async () => {
    await seed([D]);
    clock.set(at(D, "16:00", -1)); // today = 02-28 (no data), tomorrow = D
    await tick();
    await db.prepare("UPDATE action_states SET state='COMPLETED', outcome='on_time', completed_at=? WHERE action_kind='ACK' AND assignment_id=(SELECT id FROM assignments WHERE staff_id='S001')")
      .bind(at(D, "16:05", -1)).run();

    const d = await get();
    expect(d.today).toBe("2026-02-28");
    expect(d.tomorrow).toBe(D);
    const tomorrow = d.days[1];
    expect(tomorrow.state).toBe("DUTY");
    expect(tomorrow.rows).toHaveLength(10);

    const s1 = tomorrow.rows.find((r: any) => r.staffId === "S001").actions[0];
    expect(s1.kind).toBe("ACK");
    expect(s1.push.initial).toMatchObject({ status: "API_ACCEPTED", acceptedAt: at(D, "16:00", -1) });
    expect(s1.user).toMatchObject({ state: "COMPLETED", outcome: "on_time" });
    const s2 = tomorrow.rows.find((r: any) => r.staffId === "S002").actions[0];
    expect(s2.push.initial.status).toBe("API_ACCEPTED"); // pushed ...
    expect(s2.user.state).toBe("PENDING"); // ... but not acted on
    expect(s2.push.reminder).toMatchObject({ status: "QUEUED" }); // reminder already scheduled
    // AM and PM exist but nothing was pushed yet
    expect(tomorrow.rows[0].actions[1].push.initial.status).toBe("QUEUED");
    expect(tomorrow.rows[0].actions[1].user.state).toBe("PENDING");
  });

  it("never uses the word 'delivered' and never leaks LINE user ids", async () => {
    await seed([D]);
    clock.set(at(D, "16:00", -1));
    await tick();
    const { raw } = await dash();
    expect(raw.toLowerCase()).not.toContain("deliver");
    expect(raw).not.toMatch(/"U\d{3}"/);
    const page = dashboardHtml;
    expect(page.toLowerCase()).not.toContain("delivered");
  });

  it("missing data is UNKNOWN (alerted); an explicit NO_DUTY day is not", async () => {
    await seed([D], ["2026-02-28"]);
    clock.set(at(D, "09:00", -1)); // 09:00 on 02-28: today NO_DUTY, tomorrow DUTY
    await tick();
    let d = await get();
    expect(d.days[0].state).toBe("NO_DUTY");
    expect(codes(d)).not.toContain("roster_missing");

    await db.prepare("DELETE FROM roster_days WHERE duty_date = '2026-02-28'").run();
    d = await get();
    expect(d.days[0].state).toBe("UNKNOWN");
    expect(d.alerts.find((a: any) => a.code === "roster_missing")).toMatchObject({ severity: "high", message: expect.stringContaining("2026-02-28") });
  });

  it("tomorrow missing is a warning in the morning and high after noon", async () => {
    await seed(["2026-03-05"]);
    clock.set(at("2026-03-01", "09:00"));
    await tick();
    let d = await get();
    expect(d.alerts.filter((a: any) => a.code === "roster_missing").map((a: any) => a.severity)).toEqual(["high", "warn"]);
    clock.set(at("2026-03-01", "12:00"));
    await tick();
    d = await get();
    expect(d.alerts.filter((a: any) => a.code === "roster_missing").map((a: any) => a.severity)).toEqual(["high", "high"]);
  });

  it("alerts when no roster was ever published", async () => {
    await tick();
    const d = await get();
    expect(codes(d)).toContain("no_active_revision");
    expect(d.days.map((x: any) => x.state)).toEqual(["UNKNOWN", "UNKNOWN"]);
    expect(codes(d)).not.toContain("roster_missing"); // not double-reported
  });

  it("lists failed jobs with the error and alerts", async () => {
    await seed([D]);
    clock.set(at(D, "06:30"));
    line.inject({ kind: "client_error", status: 400, message: "invalid user" });
    await tick();
    const d = await get();
    expect(d.failedJobs.total).toBe(1);
    expect(d.failedJobs.items[0]).toMatchObject({ kind: "AM", phase: "INITIAL", dutyDate: D });
    expect(d.failedJobs.items[0].error).toContain("http_400");
    expect(codes(d)).toContain("failed_jobs");
    const row = d.days[0].rows.find((r: any) => r.staffId === d.failedJobs.items[0].staffId);
    expect(row.actions[1].push.initial.status).toBe("FAILED");
  });

  it("lists unbound staff on duty, and counts the unbound pool", async () => {
    await seed([D], [], { unbound: [2, 3] });
    await db.prepare("INSERT INTO people (staff_id, label) VALUES ('S900', 'Off duty, unlinked')").run();
    clock.set(at(D, "09:00"));
    await tick();
    const d = await get();
    expect(d.unbound.onDuty.map((u: any) => u.staffId)).toEqual(["S002", "S003"]);
    expect(d.unbound.poolUnbound).toBe(3);
    expect(d.unbound.poolTotal).toBe(11);
    expect(codes(d)).toContain("unbound_on_duty");
    expect(d.days[0].rows.find((r: any) => r.staffId === "S002").bound).toBe(false);
  });

  it("scheduler heartbeat: NEVER, then OK, then STALE", async () => {
    await seed([D]);
    clock.set(at(D, "09:00"));
    let d = await get();
    expect(d.scheduler.status).toBe("NEVER");
    expect(codes(d)).toContain("scheduler_never_ran");
    await tick();
    d = await get();
    expect(d.scheduler).toMatchObject({ status: "OK", lastRunAt: clock.now(), ageSeconds: 0 });
    expect(d.scheduler.lastSummary).toHaveProperty("claimed");
    expect(codes(d)).not.toContain("scheduler_stale");
    clock.advance(4 * MIN);
    d = await get();
    expect(d.scheduler.status).toBe("STALE");
    expect(d.scheduler.ageSeconds).toBe(240);
    expect(codes(d)).toContain("scheduler_stale");
  });

  it("flags actions that expired with no push ever accepted, and overdue queue", async () => {
    await seed([D]);
    clock.set(at(D, "05:00"));
    await runScheduler({ db, clock }); // plan only
    clock.set(at(D, "12:30")); // scheduler was down past the AM cutoff
    await runScheduler({ db, clock });
    let d = await get();
    expect(codes(d)).toContain("never_notified");
    expect(d.days[0].rows[0].actions[1].user.state).toBe("EXPIRED");
    // a queued PM job (due 14:20) that nobody sends
    clock.set(at(D, "14:30"));
    await runScheduler({ db, clock });
    d = await get();
    expect(codes(d)).toContain("queue_overdue");
  });

  it("the dashboard page is plain HTML, labelled as stub auth, and draws data without innerHTML", async () => {
    const page = dashboardHtml;
    expect(page).toContain("STUB AUTH");
    expect(page).not.toContain("innerHTML");
    expect(page).not.toMatch(/<script[^>]+src=["']https?:/); // no third-party scripts
  });
});
