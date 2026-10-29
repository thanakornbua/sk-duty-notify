import { beforeEach, describe, expect, it } from "vitest";
import { db, reset, seedLocation, seedMembers } from "./helpers";

const fails = (p: Promise<unknown>) => expect(p).rejects.toThrow(/UNIQUE|CHECK|constraint/);

describe("schema constraints", () => {
  beforeEach(async () => { await reset(); await seedMembers(2); await seedLocation(); });

  it("staff_code is unique", async () => {
    await fails(db.prepare("INSERT INTO members (staff_code, label, created_at) VALUES ('S001', 'x', 0)").run());
  });

  it("one member per LINE account; many unlinked members allowed", async () => {
    await fails(db.prepare("UPDATE members SET line_user_id = 'U001' WHERE id = 2").run());
    await db.prepare("UPDATE members SET line_user_id = NULL").run();
    expect((await db.prepare("SELECT COUNT(*) AS n FROM members WHERE line_user_id IS NULL").first<{ n: number }>())!.n).toBe(2);
  });

  it("one live duty per member/date/shift; cancelled ones do not count", async () => {
    const ins = () => db.prepare(
      "INSERT INTO duties (member_id, location_id, duty_date, shift, start_at, end_at, created_at, updated_at) VALUES (1, (SELECT id FROM locations), '2026-03-02', 'AM', 1, 2, 0, 0)").run();
    await ins();
    await fails(ins());
    await db.prepare("UPDATE duties SET status = 'CANCELLED'").run();
    await ins();
  });

  it("duty end must be after start, status and result enums are checked", async () => {
    await fails(db.prepare(
      "INSERT INTO duties (member_id, location_id, duty_date, shift, start_at, end_at, created_at, updated_at) VALUES (1, (SELECT id FROM locations), 'd', 'AM', 5, 5, 0, 0)").run());
    await fails(db.prepare(
      "INSERT INTO duties (member_id, location_id, duty_date, shift, start_at, end_at, status, created_at, updated_at) VALUES (1, (SELECT id FROM locations), 'd', 'AM', 1, 5, 'DELIVERED', 0, 0)").run());
    await fails(db.prepare("INSERT INTO checkins (submitted_at, result) VALUES (0, 'maybe')").run());
  });

  it("outbox dedupe_key and nonce value are unique", async () => {
    const out = () => db.prepare(
      "INSERT INTO outbox (kind, dedupe_key, member_id, duty_date, status, due_at, deadline_at, next_attempt_at, created_at, updated_at) VALUES ('PROMPT', 'P:1', 1, 'd', 'QUEUED', 0, 1, 0, 0, 0)").run();
    await out();
    await fails(out());
    await db.prepare(
      "INSERT INTO duties (id, member_id, location_id, duty_date, shift, start_at, end_at, created_at, updated_at) VALUES (9, 1, (SELECT id FROM locations), 'd', 'AM', 1, 2, 0, 0)").run();
    const n = () => db.prepare("INSERT INTO nonces (duty_id, member_id, value, created_at, expires_at) VALUES (9, 1, 'abc', 0, 1)").run();
    await n();
    await fails(n());
  });

  it("geofence point coordinates are range-checked", async () => {
    await fails(db.prepare("INSERT INTO geofence_points (location_id, lat, lng, radius_m) VALUES ((SELECT id FROM locations), 91, 0, 10)").run());
  });
});
