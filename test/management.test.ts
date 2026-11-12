import { beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock";
import { config } from "../src/config";
import { FakeLineClient } from "../src/line-fake";
import { runScheduler } from "../src/scheduler";
import { DEFAULTS, loadSchedule } from "../src/settings";
import { admin, ADMIN, amPm, at, call, D, db, dutyId, MIN, publishRows, reset, seedLocation, seedMembers, SITE, standardDay, token } from "./helpers";

let line: FakeLineClient, clock: FixedClock;
const ORIGIN = { origin: "https://x.test" };
const j = async (r: Response) => ({ status: r.status, body: (await r.json()) as any });
const signIn = (username: string, password: string) => call(line, clock, "POST", "/admin/api/login", { username, password }, ORIGIN);

beforeEach(async () => { await reset(); line = new FakeLineClient(); clock = new FixedClock(at(D, "09:00")); });

describe("management accounts", () => {
  const create = (email: string, displayName: string) => admin(line, clock, "POST", "/admin/api/admins", { email, displayName });

  it("an admin adds another by Google email; it has no usable password", async () => {
    const r = await j(await create("Coord.B@school.test", "Coordinator B"));
    expect(r).toEqual({ status: 201, body: { ok: true, username: "coord.b@school.test" } });
    expect((await signIn("coord.b@school.test", "")).status).toBe(401);
    const list = await j(await admin(line, clock, "GET", "/admin/api/admins"));
    expect(list.body.admins.map((a: any) => [a.username, a.email, a.mustChange])).toEqual([
      ["coord.b@school.test", "coord.b@school.test", false], [ADMIN.username, null, false]]);
    expect((await db.prepare("SELECT actor FROM audit_log WHERE event = 'admin_created'").first())!.actor).toBe(`admin:${ADMIN.username}`);
  });

  it("validates emails and the allowed domains, and refuses duplicates", async () => {
    expect((await j(await create("not-an-email", "x"))).body.error).toBe("invalid_email");
    expect((await j(await create("x@gmail.com", "x"))).body).toEqual({ error: "email_domain_not_allowed", domains: "school.test, student.school.test" });
    expect((await j(await create("a@school.test", ""))).body.error).toBe("invalid_display_name");
    await create("a@school.test", "A");
    expect(await j(await create("A@school.test", "A again"))).toEqual({ status: 409, body: { error: "email_taken" } });
  });

  it("disable signs the account out and blocks it; never on yourself", async () => {
    await create("c@school.test", "C");
    const id = (await db.prepare("SELECT id FROM admin_users WHERE email = 'c@school.test'").first<{ id: number }>())!.id;
    await db.prepare("INSERT INTO admin_sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES ('h', ?, 0, 9e15, 9e15)").bind(id).run();
    expect((await admin(line, clock, "POST", `/admin/api/admins/${id}/disable`)).status).toBe(200);
    expect(await db.prepare("SELECT 1 FROM admin_sessions WHERE user_id = ?").bind(id).first()).toBeNull();
    expect((await j(await admin(line, clock, "GET", "/admin/api/admins"))).body.admins.find((a: any) => a.id === id).disabled).toBe(true);
    expect((await admin(line, clock, "POST", `/admin/api/admins/${id}/enable`)).status).toBe(200);
    expect((await j(await admin(line, clock, "POST", "/admin/api/admins/1/disable"))).body.error).toBe("cannot_disable_self");
  });

  it("a break-glass account that still has a temporary password cannot manage accounts", async () => {
    await db.prepare("UPDATE admin_users SET must_change = 1 WHERE id = 1").run();
    expect((await create("e@school.test", "E")).status).toBe(403);
  });
});

describe("scheduling settings", () => {
  const valid = () => structuredClone(DEFAULTS);

  it("read, save, and apply; validation names the field", async () => {
    expect((await j(await admin(line, clock, "GET", "/admin/api/settings"))).body).toMatchObject({ schedule: DEFAULTS, updatedBy: null });
    for (const [patch, field] of [
      [{ shifts: [{ code: "AM", name: "", start: "12:00", end: "11:00" }, { code: "PM", name: "", start: "14:20", end: "18:00" }] }, "shifts.0.end"],
      [{ shifts: [{ code: "AM", name: "", start: "07:00", end: "11:00" }, { code: "am", name: "", start: "13:00", end: "14:00" }] }, "shifts.1.code"],
      [{ shifts: [{ code: "A M", name: "", start: "07:00", end: "11:00" }] }, "shifts.0.code"],
      [{ shifts: [] }, "shifts"],
      [{ reminderTime: "25:00" }, "reminderTime"],
      [{ missedAfterMinutes: 1 }, "missedAfterMinutes"],
      [{ messageLanguage: "fr" }, "messageLanguage"],
    ] as const) {
      const r = await j(await admin(line, clock, "POST", "/admin/api/settings", { ...valid(), ...patch }));
      expect([r.status, r.body.field]).toEqual([400, field]);
    }
    const s = { ...valid(), lateAfterMinutes: 10, shifts: [{ code: "AM", name: "", start: "07:00", end: "11:30" }, { code: "PM", name: "", start: "14:20", end: "18:00" }] };
    expect((await admin(line, clock, "POST", "/admin/api/settings", s)).status).toBe(200);
    expect(config.lateAfterMinutes).toBe(10);
    // Survives a fresh isolate: the next request reloads from D1.
    Object.assign(config, { lateAfterMinutes: 30 });
    await loadSchedule(db);
    expect(config.lateAfterMinutes).toBe(10);
    expect((await j(await admin(line, clock, "GET", "/admin/api/settings"))).body).toMatchObject({ updatedBy: `admin:${ADMIN.username}` });
  });

  it("new shift times apply to duties published afterwards; the late threshold applies to check-ins right away", async () => {
    await seedMembers(2); await seedLocation();
    await admin(line, clock, "POST", "/admin/api/settings", { ...valid(), lateAfterMinutes: 5, shifts: [{ code: "AM", name: "", start: "07:00", end: "11:30" }, { code: "PM", name: "", start: "14:20", end: "18:00" }] });
    await publishRows(amPm([D], 1));
    const am = await db.prepare("SELECT start_at, end_at FROM duties WHERE shift = 'AM'").first<{ start_at: number; end_at: number }>();
    expect(am).toEqual({ start_at: at(D, "07:00"), end_at: at(D, "11:30") });
    clock.set(at(D, "07:06"));
    const s = (await (await call(line, clock, "POST", "/api/checkin/start", { idToken: token(1) })).json()) as any;
    const r = (await (await call(line, clock, "POST", "/api/checkin/submit", { idToken: token(1), dutyId: s.current.dutyId, nonce: s.current.nonce, lat: SITE.lat, lng: SITE.lng, accuracy: 10 })).json()) as any;
    expect(r.duty.late).toBe(true);
  });

  it("management defines its own shifts: new codes, names and times; removed codes need explicit times in files", async () => {
    await seedMembers(2); await seedLocation();
    const shifts = [
      { code: "MORN", name: "Morning gate", start: "06:45", end: "08:00" },
      { code: "lunch", name: "", start: "12:00", end: "13:00" },
    ];
    const r = await j(await admin(line, clock, "POST", "/admin/api/settings", { ...valid(), shifts }));
    expect(r.status).toBe(200);
    expect(r.body.schedule.shifts.map((x: any) => x.code)).toEqual(["MORN", "LUNCH"]);
    expect(config.shifts.MORN).toEqual({ start: "06:45", end: "08:00", name: "Morning gate" });
    expect(config.shifts.AM).toBeUndefined();
    // The duty sheet gets the list in order.
    const sheet = await j(await admin(line, clock, "GET", `/admin/api/duties?from=${D}&to=${D}`));
    expect(sheet.body.shifts.map((x: any) => x.code)).toEqual(["MORN", "LUNCH"]);
    await publishRows([{ date: D, staffCode: "S001", locationCode: "GATE", shift: "MORN" }, { date: D, staffCode: "S002", locationCode: "GATE", shift: "LUNCH" }]);
    const m = await db.prepare("SELECT start_at, end_at FROM duties WHERE shift = 'MORN'").first<{ start_at: number; end_at: number }>();
    expect(m).toEqual({ start_at: at(D, "06:45"), end_at: at(D, "08:00") });
    // AM is no longer configured: a file row needs its own times.
    const staged = await j(await admin(line, clock, "POST", "/admin/api/imports", { rows: [{ line: 1, date: D, staffCode: "S001", locationCode: "GATE", shift: "AM" }] }));
    expect(staged.body.errors[0].code).toBe("shift_needs_times");
  });

  it("settings saved before 1.1 (AM/PM object) still load", async () => {
    await db.prepare("INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('schedule', ?, 0, 'x')")
      .bind(JSON.stringify({ ...valid(), shifts: { AM: { start: "07:10", end: "11:00" }, PM: { start: "13:00", end: "17:00" } } })).run();
    await loadSchedule(db);
    expect(config.shiftList.map((x) => [x.code, x.start])).toEqual([["AM", "07:10"], ["PM", "13:00"]]);
  });

  it("saving re-plans messages that have not been attempted yet", async () => {
    await standardDay();
    clock.set(at(D, "15:00", -1));
    await runScheduler({ db, clock });
    const before = (await db.prepare("SELECT due_at FROM outbox WHERE kind = 'REMINDER' LIMIT 1").first<{ due_at: number }>())!.due_at;
    expect(before).toBe(at(D, "16:00", -1));
    const r = await j(await admin(line, clock, "POST", "/admin/api/settings", { ...valid(), reminderTime: "18:30", missedAfterMinutes: 45 }));
    expect(r.body.replanned).toBe(30); // 10 reminders + 20 missed
    await runScheduler({ db, clock });
    expect((await db.prepare("SELECT due_at FROM outbox WHERE kind = 'REMINDER' LIMIT 1").first<{ due_at: number }>())!.due_at).toBe(at(D, "18:30", -1));
    expect((await db.prepare("SELECT due_at FROM outbox WHERE kind = 'MISSED' AND duty_id = ?").bind(await dutyId(1)).first<{ due_at: number }>())!.due_at)
      .toBe(at(D, "06:30") + 45 * MIN);
  });
});

describe("duty sheet data", () => {
  it("returns members, usable locations, duties and known dates for a range", async () => {
    await standardDay();
    await seedLocation("NOPTS", []);
    const r = await j(await admin(line, clock, "GET", `/admin/api/duties?from=${D}&to=2026-03-08`));
    expect(r.body.members.length).toBe(10);
    expect(r.body.locations.map((l: any) => l.code)).toEqual(["GATE"]); // no geofence point -> not offered
    expect(r.body.knownDates).toEqual([D]);
    expect(r.body.duties[0]).toMatchObject({ staffCode: "S001", date: D, shift: "AM", locationCode: "GATE", start: "06:30", end: "12:00", status: "PENDING" });
    expect((await j(await admin(line, clock, "GET", `/admin/api/duties?from=${D}&to=2026-05-01`))).body.error).toBe("range_too_long");
  });
});
