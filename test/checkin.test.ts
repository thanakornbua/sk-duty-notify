import { beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock";
import { config } from "../src/config";
import { FakeLineClient } from "../src/line-fake";
import { at, call, D, db, dutyId, MIN, publishRows, reset, seedLocation, seedMembers, SITE, standardDay, token } from "./helpers";

let line: FakeLineClient, clock: FixedClock;
const IN = { lat: SITE.lat + 0.0003, lng: SITE.lng, accuracy: 15 };   // ~33 m from centre
const OUT = { lat: SITE.lat + 0.002, lng: SITE.lng, accuracy: 15 };   // ~222 m

async function start(n = 1) {
  const res = await call(line, clock, "POST", "/api/checkin/start", { idToken: token(n) });
  return { status: res.status, body: (await res.json()) as any };
}
async function submit(body: Record<string, unknown>, n = 1) {
  const res = await call(line, clock, "POST", "/api/checkin/submit", { idToken: token(n), clientTs: clock.now(), ...body });
  return { status: res.status, body: (await res.json()) as any };
}
/** start + submit with the issued nonce. */
async function checkIn(pos: Record<string, unknown> = IN, n = 1) {
  const s = await start(n);
  return submit({ dutyId: s.body.current?.dutyId, nonce: s.body.current?.nonce, ...pos }, n);
}
const attempts = async () => (await db.prepare("SELECT * FROM checkins ORDER BY id").all<Record<string, any>>()).results;
const duty = async (n = 1, shift = "AM") => db.prepare("SELECT * FROM duties WHERE id = ?").bind(await dutyId(n, shift)).first<Record<string, any>>();

beforeEach(async () => {
  await standardDay({ unlinked: [10] });
  line = new FakeLineClient();
  clock = new FixedClock(at(D, "06:40"));
});

describe("acceptance criteria (spec 12)", () => {
  it("AC1: inside the geofence, inside the window, acceptable accuracy -> checked in", async () => {
    const r = await checkIn();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ result: "ok", radiusM: 100, duty: { status: "CHECKED_IN", late: false } });
    expect(r.body.distanceM).toBeCloseTo(33.4, 0);
    expect(await duty()).toMatchObject({ status: "CHECKED_IN", source: "gps", late: 0, checked_in_at: clock.now() });
    const [a] = await attempts();
    expect(a).toMatchObject({ result: "ok", member_id: 1, duty_id: await dutyId(1), submitted_at: clock.now(), accuracy_m: 15 });
  });

  it("AC2: outside the geofence -> rejected and logged with the distance", async () => {
    const r = await checkIn(OUT);
    expect(r).toMatchObject({ status: 422, body: { result: "outside_geofence", radiusM: 100 } });
    expect((await duty())!.status).toBe("PENDING");
    const [a] = await attempts();
    expect(a.result).toBe("outside_geofence");
    expect(a.distance_m).toBeCloseTo(222.4, 0);
  });

  it("AC2: outside the time window -> rejected and logged (too early and too late)", async () => {
    clock.set(at(D, "06:14"));
    expect((await checkIn()).body).toMatchObject({ result: "outside_window", reason: "too_early" });
    clock.set(at(D, "12:00") + 1);
    const s = await start(); // AM closed; the nonce is now for PM
    expect(s.body.current.dutyId).toBe(await dutyId(1, "PM"));
    expect((await submit({ dutyId: await dutyId(1, "AM"), nonce: s.body.current.nonce, ...IN })).body)
      .toMatchObject({ result: "outside_window", reason: "too_late" });
    expect((await attempts()).map((a) => `${a.result}:${a.reason}`)).toEqual(["outside_window:too_early", "outside_window:too_late"]);
  });

  it("AC3: a nonce cannot be reused (after a failure or a success)", async () => {
    const s = await start();
    const body = { dutyId: s.body.current.dutyId, nonce: s.body.current.nonce };
    expect((await submit({ ...body, ...OUT })).body.result).toBe("outside_geofence");
    expect(await submit({ ...body, ...IN })).toMatchObject({ status: 409, body: { result: "rejected", reason: "nonce_used" } });
    const s2 = await start();
    expect((await submit({ dutyId: s2.body.current.dutyId, nonce: s2.body.current.nonce, ...IN })).body.result).toBe("ok");
    await db.prepare("UPDATE duties SET status = 'PENDING' WHERE id = ?").bind(body.dutyId).run();
    expect((await submit({ dutyId: s2.body.current.dutyId, nonce: s2.body.current.nonce, ...IN })).body.reason).toBe("nonce_used");
  });

  it("AC3: two concurrent submits with the same nonce: exactly one is processed", async () => {
    const s = await start();
    const body = { dutyId: s.body.current.dutyId, nonce: s.body.current.nonce, ...IN };
    const results = await Promise.all([submit(body), submit(body), submit(body)]);
    expect(results.filter((r) => r.body.reason === "nonce_used").length).toBe(2);
    expect(results.filter((r) => r.body.result === "ok").length).toBe(1);
    expect((await attempts()).length).toBe(3);
  });
});

describe("identity", () => {
  it("forged ID token: rejected, logged with no member", async () => {
    const res = await call(line, clock, "POST", "/api/checkin/submit", { idToken: "forged", dutyId: 1, nonce: "x", ...IN });
    expect(res.status).toBe(401);
    expect((await attempts())[0]).toMatchObject({ result: "rejected", reason: "invalid_token", member_id: null });
  });

  it("a userId sent by the client is ignored; only the token counts", async () => {
    const s = await start(1);
    const r = await submit({ dutyId: s.body.current.dutyId, nonce: s.body.current.nonce, userId: "U002", memberId: 2, ...IN }, 1);
    expect(r.body.result).toBe("ok");
    expect((await duty(2))!.status).toBe("PENDING");
  });

  it("verified LINE account that is not linked to any member", async () => {
    expect((await start(10)).status).toBe(403);
    const r = await submit({ dutyId: 1, nonce: "x", ...IN }, 10);
    expect(r).toMatchObject({ status: 403, body: { reason: "not_linked" } });
  });

  it("someone else's duty (e.g. a forwarded message) cannot be checked in", async () => {
    const s = await start(1);
    const r = await submit({ dutyId: await dutyId(2), nonce: s.body.current.nonce, ...IN }, 1);
    expect(r).toMatchObject({ status: 403, body: { reason: "not_your_duty" } });
    // Member 2 using member 1's nonce on their own duty: the nonce is bound to member 1.
    const r2 = await submit({ dutyId: await dutyId(2), nonce: s.body.current.nonce, ...IN }, 2);
    expect(r2.body.reason).toBe("bad_nonce");
    expect((await duty(2))!.status).toBe("PENDING");
  });

  it("LINE verify unreachable -> 503, nothing changes", async () => {
    line.verifyDown = true;
    expect((await start()).status).toBe(503);
  });
});

describe("window, nonce, accuracy rules", () => {
  it("window edges: opens at start - 15 min, closes at end, both inclusive", async () => {
    clock.set(at(D, "06:15"));
    expect((await checkIn()).body.result).toBe("ok");
    clock.set(at(D, "18:00"));
    expect((await checkIn(IN)).body.result).toBe("ok"); // PM, at its end
    expect((await duty(1, "PM"))!.late).toBe(1);
  });

  it("late: start + 30:00 is on time, one ms later is late", async () => {
    clock.set(at(D, "07:00"));
    expect((await checkIn(IN, 1)).body.duty.late).toBe(false);
    clock.set(at(D, "07:00") + 1);
    expect((await checkIn(IN, 2)).body.duty.late).toBe(true);
  });

  it("the server clock decides, not the phone's timestamp", async () => {
    clock.set(at(D, "13:00"));
    const s = await start();
    const r = await submit({ dutyId: await dutyId(1, "AM"), nonce: s.body.current?.nonce, ...IN, clientTs: at(D, "07:00") });
    expect(r.body.result).toBe("outside_window");
  });

  it("expired nonce and nonce for another duty", async () => {
    const s = await start();
    clock.advance(config.nonceTtlSeconds * 1000);
    expect((await submit({ dutyId: s.body.current.dutyId, nonce: s.body.current.nonce, ...IN })).body.reason).toBe("nonce_expired");
    await db.prepare("INSERT INTO nonces (duty_id, member_id, value, created_at, expires_at) VALUES (?, 1, 'pm-nonce', 0, ?)")
      .bind(await dutyId(1, "PM"), clock.now() + MIN).run();
    expect((await submit({ dutyId: s.body.current.dutyId, nonce: "pm-nonce", ...IN })).body.reason).toBe("bad_nonce");
  });

  it("low accuracy is rejected before the geofence, distance still stored", async () => {
    const r = await checkIn({ ...IN, accuracy: 51 });
    expect(r).toMatchObject({ status: 422, body: { result: "low_accuracy", allowedAccuracyM: 50 } });
    expect((await attempts())[0].distance_m).toBeGreaterThan(30);
    expect((await checkIn({ ...IN, accuracy: 50 })).body.result).toBe("ok");
  });

  it("non-numeric or out-of-range coordinates", async () => {
    expect((await checkIn({ lat: "13.75", lng: SITE.lng, accuracy: 10 })).body.reason).toBe("bad_coords");
    expect((await checkIn({ lat: 95, lng: SITE.lng, accuracy: 10 })).body.reason).toBe("bad_coords");
  });

  it("double submit after success is idempotent and reports the existing status", async () => {
    await checkIn();
    const r = await submit({ dutyId: await dutyId(1), nonce: "whatever", ...IN });
    expect(r).toMatchObject({ status: 200, body: { result: "ok", reason: "already_checked_in", duty: { status: "CHECKED_IN" } } });
  });

  it("cancelled duty", async () => {
    const s = await start();
    await db.prepare("UPDATE duties SET status = 'CANCELLED' WHERE id = ?").bind(s.body.current.dutyId).run();
    expect((await submit({ dutyId: s.body.current.dutyId, nonce: s.body.current.nonce, ...IN })).body.reason).toBe("duty_cancelled");
  });

  it("per-member rate limit; extra attempts are still logged", async () => {
    for (let i = 0; i < config.checkinRateLimit.max; i++) await checkIn(OUT);
    const r = await checkIn(IN);
    expect(r).toMatchObject({ status: 429, body: { reason: "rate_limited" } });
    clock.advance(config.checkinRateLimit.windowMinutes * MIN + 1);
    expect((await checkIn(IN)).body.result).toBe("ok");
  });
});

describe("consent and multi-point sites", () => {
  it("no check-in before the consent notice is accepted", async () => {
    await db.prepare("UPDATE members SET consent_at = NULL WHERE id = 1").run();
    const s = await start();
    expect(s.body).toMatchObject({ needsConsent: true, consentText: config.consentText });
    expect((await submit({ dutyId: s.body.current.dutyId, nonce: s.body.current.nonce, ...IN })).body.reason).toBe("no_consent");
    await call(line, clock, "POST", "/api/consent", { idToken: token(1) });
    expect((await checkIn()).body.result).toBe("ok");
  });

  it("a check-in passes if inside ANY geofence point", async () => {
    await reset();
    await seedMembers(1);
    await seedLocation("CAMPUS", [{ ...SITE, radius_m: 50 }, { lat: SITE.lat + 0.01, lng: SITE.lng, radius_m: 80 }]);
    await publishRows([{ date: D, staffCode: "S001", locationCode: "CAMPUS", shift: "AM" }]);
    expect((await checkIn({ lat: SITE.lat + 0.0105, lng: SITE.lng, accuracy: 10 })).body.result).toBe("ok"); // ~56 m from point 2
  });

  it("start lists today's duties and marks which one is open", async () => {
    const s = await start();
    expect(s.body.duties.map((d: any) => `${d.shift}:${d.open}`)).toEqual(["AM:true", "PM:false"]);
    expect(s.body.member).toEqual({ staffCode: "S001", label: "Person 1" });
  });
});
