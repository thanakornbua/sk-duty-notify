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
  it("an admin creates another account; it signs in with the temporary password and must change it", async () => {
    const r = await j(await admin(line, clock, "POST", "/admin/api/admins", { username: "coord.b", displayName: "Coordinator B" }));
    expect(r.status).toBe(201);
    expect(r.body.temporaryPassword).toMatch(/^[A-HJ-NP-Za-hj-kmnp-z2-9]{16}$/);
    const login = await j(await signIn("coord.b", r.body.temporaryPassword));
    expect(login.body.user).toEqual({ username: "coord.b", displayName: "Coordinator B", mustChange: true });
    const list = await j(await admin(line, clock, "GET", "/admin/api/admins"));
    expect(list.body.admins.map((a: any) => [a.username, a.mustChange])).toEqual([["coord.b", true], [ADMIN.username, false]]);
    expect(list.body.admins.find((a: any) => a.username === "coord.b").lastLoginAt).toBe(clock.now());
    expect((await db.prepare("SELECT actor FROM audit_log WHERE event = 'admin_created'").first())!.actor).toBe(`admin:${ADMIN.username}`);
  });

  it("validates usernames and refuses duplicates (case-insensitive)", async () => {
    expect((await j(await admin(line, clock, "POST", "/admin/api/admins", { username: "a b", displayName: "x" }))).body.error).toBe("invalid_username");
    expect((await j(await admin(line, clock, "POST", "/admin/api/admins", { username: "abc", displayName: "" }))).body.error).toBe("invalid_display_name");
    expect((await j(await admin(line, clock, "POST", "/admin/api/admins", { username: ADMIN.username.toUpperCase(), displayName: "x" })))).toEqual({ status: 409, body: { error: "username_taken" } });
  });

  it("reset gives a new temporary password and signs the account out; disable blocks it; never on yourself", async () => {
    const created = await j(await admin(line, clock, "POST", "/admin/api/admins", { username: "coord.c", displayName: "C" }));
    const id = (await db.prepare("SELECT id FROM admin_users WHERE username = 'coord.c'").first<{ id: number }>())!.id;
    const session = (await signIn("coord.c", created.body.temporaryPassword)).headers.get("set-cookie")!.split(";")[0];
    const reset1 = await j(await admin(line, clock, "POST", `/admin/api/admins/${id}/reset-password`));
    expect(reset1.body.temporaryPassword).not.toBe(created.body.temporaryPassword);
    expect((await call(line, clock, "GET", "/admin/api/me", undefined, { cookie: session })).status).toBe(401);
    expect((await signIn("coord.c", created.body.temporaryPassword)).status).toBe(401);
    expect((await signIn("coord.c", reset1.body.temporaryPassword)).status).toBe(200);

    expect((await admin(line, clock, "POST", `/admin/api/admins/${id}/disable`)).status).toBe(200);
    expect((await signIn("coord.c", reset1.body.temporaryPassword)).status).toBe(401);
    expect((await admin(line, clock, "POST", `/admin/api/admins/${id}/enable`)).status).toBe(200);
    expect((await signIn("coord.c", reset1.body.temporaryPassword)).status).toBe(200);

    expect((await j(await admin(line, clock, "POST", "/admin/api/admins/1/disable"))).body.error).toBe("cannot_disable_self");
    expect((await j(await admin(line, clock, "POST", "/admin/api/admins/1/reset-password"))).body.error).toBe("use_account_page");
  });

  it("an account that still has a temporary password cannot manage accounts", async () => {
    const created = await j(await admin(line, clock, "POST", "/admin/api/admins", { username: "coord.d", displayName: "D" }));
    const session = (await signIn("coord.d", created.body.temporaryPassword)).headers.get("set-cookie")!.split(";")[0];
    const r = await call(line, clock, "POST", "/admin/api/admins", { username: "evil", displayName: "x" }, { cookie: session, ...ORIGIN });
    expect(r.status).toBe(403);
  });
});

describe("scheduling settings", () => {
  const valid = () => structuredClone(DEFAULTS);

  it("read, save, and apply; validation names the field", async () => {
    expect((await j(await admin(line, clock, "GET", "/admin/api/settings"))).body).toMatchObject({ schedule: DEFAULTS, updatedBy: null });
    for (const [patch, field] of [
      [{ shifts: { AM: { start: "12:00", end: "11:00" }, PM: DEFAULTS.shifts.PM } }, "shifts.AM"],
      [{ reminderTime: "25:00" }, "reminderTime"],
      [{ missedAfterMinutes: 1 }, "missedAfterMinutes"],
      [{ messageLanguage: "fr" }, "messageLanguage"],
    ] as const) {
      const r = await j(await admin(line, clock, "POST", "/admin/api/settings", { ...valid(), ...patch }));
      expect([r.status, r.body.field]).toEqual([400, field]);
    }
    const s = { ...valid(), lateAfterMinutes: 10, shifts: { AM: { start: "07:00", end: "11:30" }, PM: DEFAULTS.shifts.PM } };
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
    await admin(line, clock, "POST", "/admin/api/settings", { ...valid(), lateAfterMinutes: 5, shifts: { AM: { start: "07:00", end: "11:30" }, PM: DEFAULTS.shifts.PM } });
    await publishRows(amPm([D], 1));
    const am = await db.prepare("SELECT start_at, end_at FROM duties WHERE shift = 'AM'").first<{ start_at: number; end_at: number }>();
    expect(am).toEqual({ start_at: at(D, "07:00"), end_at: at(D, "11:30") });
    clock.set(at(D, "07:06"));
    const s = (await (await call(line, clock, "POST", "/api/checkin/start", { idToken: token(1) })).json()) as any;
    const r = (await (await call(line, clock, "POST", "/api/checkin/submit", { idToken: token(1), dutyId: s.current.dutyId, nonce: s.current.nonce, lat: SITE.lat, lng: SITE.lng, accuracy: 10 })).json()) as any;
    expect(r.duty.late).toBe(true);
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
