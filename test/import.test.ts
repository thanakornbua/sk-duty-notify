import { beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock";
import { publishImport, stageImport } from "../src/importer";
import { amPm, at, D, db, publishRows, reset, sc, seedLocation, seedMembers } from "./helpers";

const clock = new FixedClock(at(D, "08:00", -7));
const errorsOf = async (rows: unknown[]) => {
  const r = await stageImport(db, clock, { rows });
  return r.ok ? [] : r.errors;
};
const live = async () => (await db.prepare("SELECT d.id, m.staff_code, d.shift, d.status, d.start_at FROM duties d JOIN members m ON m.id = d.member_id WHERE d.status != 'CANCELLED' ORDER BY d.id").all<{ id: number; staff_code: string; shift: string; status: string; start_at: number }>()).results;

describe("roster import", () => {
  beforeEach(async () => { await reset(); await seedMembers(5); await seedLocation(); await seedLocation("NOPTS", []); });

  it("publishes AM/PM duties with config times as Bangkok instants", async () => {
    const res = await publishRows(amPm([D], 3));
    expect(res.insert).toBe(6);
    const rows = await live();
    expect(rows.find((r) => r.shift === "AM")!.start_at).toBe(at(D, "06:30"));
    expect(rows.find((r) => r.shift === "PM")!.start_at).toBe(at(D, "14:20"));
    expect((await db.prepare("SELECT duty_date FROM roster_dates").all()).results).toEqual([{ duty_date: D }]);
  });

  it("rejects bad rows with row numbers and stores nothing", async () => {
    const errs = await errorsOf([
      { date: "2026-02-30", staffCode: "S001", locationCode: "GATE", shift: "AM" },
      { date: D, staffCode: "S999", locationCode: "GATE", shift: "AM" },
      { date: D, staffCode: "S001", locationCode: "NOWHERE", shift: "AM" },
      { date: D, staffCode: "S002", locationCode: "NOPTS", shift: "AM" },
      { date: D, staffCode: "S003", locationCode: "GATE", shift: "NIGHT" },
      { date: D, staffCode: "S004", locationCode: "GATE", shift: "X", start: "10:00", end: "09:00" },
      { date: D, staffCode: "S005", locationCode: "GATE", shift: "AM" },
      { date: D, staffCode: "S005", locationCode: "GATE", shift: "AM" },
    ]);
    expect(errs).toEqual(expect.arrayContaining([
      { code: "invalid_date", row: 1, value: "2026-02-30" },
      { code: "unknown_staff", row: 2, value: "S999" },
      { code: "unknown_location", row: 3, value: "NOWHERE" },
      { code: "location_without_points", row: 4, value: "NOPTS" },
      { code: "shift_needs_times", row: 5, value: "NIGHT" },
      { code: "end_before_start", row: 6, start: "10:00", end: "09:00" },
      { code: "duplicate_shift", row: 8, value: "S005", shift: "AM", date: D },
    ]));
    expect((await db.prepare("SELECT COUNT(*) AS n FROM import_batches").first<{ n: number }>())!.n).toBe(0);
  });

  it("rejects overlapping duties for one member and mixed no-duty dates", async () => {
    expect((await errorsOf([
      { date: D, staffCode: "S001", locationCode: "GATE", shift: "AM" },
      { date: D, staffCode: "S001", locationCode: "GATE", shift: "X", start: "11:00", end: "13:00" },
    ])).map((e) => e.code)).toEqual(["overlap"]);
    expect((await errorsOf([
      { date: D, staffCode: "", locationCode: "", shift: "" },
      { date: D, staffCode: "S001", locationCode: "GATE", shift: "AM" },
    ])).map((e) => e.code)).toEqual(["mixed_no_duty"]);
  });

  it("custom shifts with explicit times, and explicit no-duty dates", async () => {
    await publishRows([
      { date: D, staffCode: "S001", locationCode: "GATE", shift: "EVENT", start: "09:00", end: "11:00" },
      { date: "2026-03-03", staffCode: "", locationCode: "", shift: "" },
    ]);
    expect((await live())[0].start_at).toBe(at(D, "09:00"));
    expect((await db.prepare("SELECT COUNT(*) AS n FROM roster_dates").first<{ n: number }>())!.n).toBe(2);
  });

  it("republish: unchanged kept, changed re-created, removed cancelled; other dates untouched", async () => {
    await publishRows([...amPm([D], 3), ...amPm(["2026-03-03"], 1)]);
    const before = await live();
    const keptId = before.find((r) => r.staff_code === "S001" && r.shift === "AM")!.id;
    const res = await publishRows([
      { date: D, staffCode: "S001", locationCode: "GATE", shift: "AM" },
      { date: D, staffCode: "S002", locationCode: "GATE", shift: "AM", start: "07:00" },
    ]);
    expect(res).toMatchObject({ insert: 1, keep: 1, cancel: 5 });
    const after = await live();
    expect(after.find((r) => r.staff_code === "S001" && r.shift === "AM")!.id).toBe(keptId);
    expect(after.find((r) => r.staff_code === "S002")!.start_at).toBe(at(D, "07:00"));
    expect(after.filter((r) => r.staff_code === "S001").length).toBe(3); // AM on D + AM/PM on 03-03
  });

  it("checked-in duties are never removed by a new file, only warned about", async () => {
    await publishRows(amPm([D], 1));
    await db.prepare("UPDATE duties SET status = 'CHECKED_IN' WHERE shift = 'AM'").run();
    const res = await publishRows([{ date: D, staffCode: sc(2), locationCode: "GATE", shift: "AM" }]);
    expect(res.warnings).toEqual([expect.objectContaining({ code: "resolved_kept", date: D, status: "CHECKED_IN" })]);
    expect((await live()).map((r) => `${r.staff_code} ${r.shift} ${r.status}`)).toEqual(["S001 AM CHECKED_IN", "S002 AM PENDING"]);
  });

  it("a batch publishes once; publish revalidates against current members", async () => {
    const staged = await stageImport(db, clock, { rows: amPm([D], 1) });
    if (!staged.ok) throw new Error();
    await db.prepare("UPDATE members SET active = 0 WHERE staff_code = 'S001'").run();
    const res = await publishImport(db, clock, staged.value.batchId);
    expect(res.ok).toBe(false);
    await db.prepare("UPDATE members SET active = 1").run();
    expect((await publishImport(db, clock, staged.value.batchId)).ok).toBe(true);
    expect(await publishImport(db, clock, staged.value.batchId)).toMatchObject({ ok: false, status: 409 });
  });
});
