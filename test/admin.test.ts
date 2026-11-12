import { beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock";
import { FakeLineClient } from "../src/line-fake";
import { findAnomalies } from "../src/report";
import { runScheduler } from "../src/scheduler";
import { admin, at, call, D, db, dutyId, LIFF, MIN, SITE, standardDay, token } from "./helpers";

let line: FakeLineClient, clock: FixedClock;
beforeEach(async () => { await standardDay({ unlinked: [9] }); line = new FakeLineClient(); clock = new FixedClock(at(D, "06:40")); });

async function checkIn(n: number, pos = { lat: SITE.lat, lng: SITE.lng, accuracy: 10 }) {
  const s = (await (await call(line, clock, "POST", "/api/checkin/start", { idToken: token(n) })).json()) as any;
  return call(line, clock, "POST", "/api/checkin/submit", { idToken: token(n), dutyId: s.current.dutyId, nonce: s.current.nonce, clientTs: clock.now(), ...pos });
}
const today = async (date = D) => (await (await admin(line, clock, "GET", `/admin/api/today?date=${date}`)).json()) as any;

describe("admin API", () => {
  it("all admin routes need a signed-in session", async () => {
    for (const p of ["/admin/api/today", "/admin/api/members", "/admin/api/checkins", "/admin/api/export.csv?from=2026-03-02"]) {
      expect((await call(line, clock, "GET", p)).status).toBe(401);
    }
  });

  it("AC5: who has and has not checked in, with reasons, push status kept separate", async () => {
    await runScheduler({ db, clock: new FixedClock(at(D, "06:30")), line, liffId: LIFF, rand: () => 0.5 });
    await checkIn(1);
    await checkIn(2, { lat: SITE.lat + 0.01, lng: SITE.lng, accuracy: 10 });
    const t = await today();
    expect(t.counts).toMatchObject({ total: 20, checkedIn: 1, pending: 19, rejectedAttempts: 1 });
    const d1 = t.duties.find((d: any) => d.staffCode === "S001" && d.shift === "AM");
    expect(d1).toMatchObject({ status: "CHECKED_IN", source: "gps", attempts: 1 });
    expect(d1.push.PROMPT).toMatchObject({ status: "API_ACCEPTED" });
    const d2 = t.duties.find((d: any) => d.staffCode === "S002" && d.shift === "AM");
    expect(d2).toMatchObject({ status: "PENDING", rejected: 1, lastAttempt: { result: "outside_geofence" } });
    expect(JSON.stringify(t)).not.toMatch(/delivered|U00\d/i); // no "delivered", no LINE ids
    expect(t.alerts.map((a: any) => a.code)).toContain("unlinked_on_duty");
  });

  it("unknown roster dates are flagged, never shown as a day off", async () => {
    const t = await today("2026-03-05");
    expect(t).toMatchObject({ rosterKnown: false, counts: { total: 0 } });
    expect((await today()).alerts.map((a: any) => a.code)).toContain("roster_unknown_tomorrow");
  });

  it("override needs a note, is audited, and works on MISSED duties", async () => {
    const id = await dutyId(3);
    expect((await admin(line, clock, "POST", `/admin/api/duties/${id}/override`, { note: "" })).status).toBe(400);
    await db.prepare("UPDATE duties SET status = 'MISSED' WHERE id = ?").bind(id).run();
    expect((await admin(line, clock, "POST", `/admin/api/duties/${id}/override`, { note: "GPS failed indoors, seen by coordinator" })).status).toBe(200);
    expect(await db.prepare("SELECT status, source, override_note, override_by FROM duties WHERE id = ?").bind(id).first())
      .toEqual({ status: "CHECKED_IN", source: "override", override_note: "GPS failed indoors, seen by coordinator", override_by: "ops.admin" });
    expect((await db.prepare("SELECT actor FROM audit_log WHERE event = 'duty_override'").first())!.actor).toBe("admin:ops.admin");
    expect((await admin(line, clock, "POST", `/admin/api/duties/${id}/override`, { note: "again" })).status).toBe(409);
  });

  it("raw coordinates only through the admin attempts endpoint", async () => {
    await checkIn(1);
    const r = (await (await admin(line, clock, "GET", `/admin/api/checkins?date=${D}`)).json()) as any;
    expect(r.attempts[0]).toMatchObject({ staff_code: "S001", lat: SITE.lat, lng: SITE.lng });
    expect(JSON.stringify(await today())).not.toContain(String(SITE.lng));
  });

  it("CSV export escapes text and neutralises formulas", async () => {
    await db.prepare("UPDATE members SET label = '=HYPERLINK(\"x\")' WHERE id = 1").run();
    await checkIn(1);
    const res = await admin(line, clock, "GET", `/admin/api/export.csv?from=${D}&to=${D}`);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    const csv = await res.text();
    const lines = csv.trim().split("\r\n");
    expect(lines.length).toBe(21);
    expect(lines[0]).toMatch(/^date,staff_code,label/);
    expect(lines[1]).toContain(`"'=HYPERLINK(""x"")"`);
    expect(lines[1]).toMatch(/CHECKED_IN,no,2026-03-02 06:40,gps/);
  });

  it("locations: upsert replaces points and validates ranges", async () => {
    const bad = await admin(line, clock, "POST", "/admin/api/locations", { code: "HALL", name: "Hall", points: [{ lat: 13.7, lng: 100.5, radiusM: 5 }] });
    expect(bad.status).toBe(400);
    const ok = await admin(line, clock, "POST", "/admin/api/locations", { code: "HALL", name: "Hall", allowedAccuracyM: 80,
      points: [{ lat: 13.7, lng: 100.5 }, { lat: 13.701, lng: 100.5, radiusM: 150 }] });
    expect(ok.status).toBe(200);
    const list = (await (await admin(line, clock, "GET", "/admin/api/locations")).json()) as any;
    const hall = list.locations.find((l: any) => l.code === "HALL");
    expect(hall.points.map((p: any) => p.radius_m)).toEqual([100, 150]);
  });

  it("a location can be edited after check-ins; old attempts keep their original point", async () => {
    await checkIn(1);
    const before = await db.prepare("SELECT point_id FROM checkins").first<{ point_id: number }>();
    const res = await admin(line, clock, "POST", "/admin/api/locations", { code: "GATE", name: "Moved", points: [{ lat: SITE.lat + 0.01, lng: SITE.lng, radiusM: 50 }] });
    expect(res.status).toBe(200);
    expect((await db.prepare("SELECT retired_at FROM geofence_points WHERE id = ?").bind(before!.point_id).first())!.retired_at).toBe(clock.now());
    const list = (await (await admin(line, clock, "GET", "/admin/api/locations")).json()) as any;
    expect(list.locations.find((l: any) => l.code === "GATE").points.map((p: any) => p.radius_m)).toEqual([50]);
    // The new geofence applies: the old spot is now outside.
    expect((await (await checkIn(2)).json() as any).result).toBe("outside_geofence");
  });

  it("members upsert with Google emails", async () => {
    const up = (members: unknown[]) => admin(line, clock, "POST", "/admin/api/members", { members });
    expect((await up([{ staffCode: "S100", label: "Person 100", email: "P100@School.test" }, { staffCode: "first.la", label: "Dot code" }])).status).toBe(200);
    expect((await db.prepare("SELECT email FROM members WHERE staff_code = 'S100'").first())!.email).toBe("p100@school.test");
    expect((await up([{ staffCode: "bad code", label: "x" }])).status).toBe(400);
    expect(((await (await up([{ staffCode: "S101", label: "x", email: "x@gmail.com" }])).json()) as any).error).toBe("invalid_member_email");
    expect(((await (await up([{ staffCode: "S101", label: "x", email: "a@school.test" }, { staffCode: "S102", label: "y", email: "A@school.test" }])).json()) as any))
      .toEqual({ error: "duplicate_member_email", index: 2 });
    expect((await up([{ staffCode: "S103", label: "z", email: "p100@school.test" }])).status).toBe(409);
    // Re-upserting without an email keeps the stored one.
    await up([{ staffCode: "S100", label: "Renamed" }]);
    expect((await db.prepare("SELECT email FROM members WHERE staff_code = 'S100'").first())!.email).toBe("p100@school.test");
  });
});

describe("anomaly flags", () => {
  const a = (id: number, member: number, t: number, lat: number, extra: Record<string, unknown> = {}) =>
    ({ id, duty_id: null, member_id: member, submitted_at: t, client_ts: t, lat, lng: 100.5, accuracy_m: 10, distance_m: 0, result: "ok", reason: null, ...extra }) as any;

  it("identical coordinates across members, impossible jumps, repeated low accuracy, zero accuracy, clock skew", () => {
    const t = at(D, "06:40");
    const kinds = findAnomalies([
      a(1, 1, t, 13.75), a(2, 2, t, 13.75),                                  // identical
      a(3, 3, t, 13.75), a(4, 3, t + 60_000, 13.80),                         // 5.5 km in 1 min
      ...[5, 6, 7].map((i) => a(i, 4, t + i, 13.7, { result: "low_accuracy" })),
      a(8, 5, t, 13.6, { accuracy_m: 0 }),
      a(9, 6, t, 13.5, { client_ts: t - 10 * MIN }),
    ]).map((x) => x.kind);
    expect(kinds).toEqual(expect.arrayContaining(["identical_coords", "impossible_jump", "repeated_low_accuracy", "zero_accuracy", "clock_skew"]));
  });

  it("small GPS jitter is not an impossible jump", () => {
    const t = at(D, "06:40");
    expect(findAnomalies([a(1, 1, t, 13.75), a(2, 1, t + 5000, 13.7501)])).toEqual([]);
  });
});

describe("retention", () => {
  it("raw lat/lng are purged after the retention period; result and distance remain", async () => {
    await checkIn(1);
    await runScheduler({ db, clock: new FixedClock(clock.now() + 91 * 1440 * MIN) });
    const row = await db.prepare("SELECT lat, lng, result, distance_m FROM checkins").first<Record<string, unknown>>();
    expect(row).toMatchObject({ lat: null, lng: null, result: "ok" });
    expect(row!.distance_m).not.toBeNull();
  });
});
