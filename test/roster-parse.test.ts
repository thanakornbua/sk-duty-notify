import { describe, expect, it } from "vitest";
import { normalizeDate, normalizeRows, normalizeTime } from "../public/roster.js";

describe("browser roster parser", () => {
  it("dates: Excel serials (1900/1904), ISO, day-first, Buddhist era", () => {
    expect(normalizeDate(46083)).toBe("2026-03-02");
    expect(normalizeDate(46083 - 1462, true)).toBe("2026-03-02");
    expect(normalizeDate("2026-3-2")).toBe("2026-03-02");
    expect(normalizeDate("02/03/2026")).toBe("2026-03-02");
    expect(normalizeDate("2/3/2569")).toBe("2026-03-02");
    expect(normalizeDate("March 2")).toBe("March 2"); // left for the server to reject
  });

  it("times: Excel fractions and H:MM", () => {
    expect(normalizeTime(0.2708333)).toBe("06:30");
    expect(normalizeTime("6:30")).toBe("06:30");
    expect(normalizeTime("")).toBe("");
  });

  it("rows by header name in any order, blank lines skipped, line numbers kept", () => {
    const { rows, errors } = normalizeRows([
      ["Shift", "Staff Code", "Date", "Location_Code", "Start", "End"],
      ["am", "S001", "2026-03-02", "GATE", "", ""],
      [],
      ["X", "S002", 46083, "GATE", 0.375, "11:00"],
      [undefined, "", "2026-03-03", "", "", ""],
    ]);
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { line: 2, date: "2026-03-02", staffCode: "S001", locationCode: "GATE", shift: "AM", start: "", end: "" },
      { line: 4, date: "2026-03-02", staffCode: "S002", locationCode: "GATE", shift: "X", start: "09:00", end: "11:00" },
      { line: 5, date: "2026-03-03", staffCode: "", locationCode: "", shift: "", start: "", end: "" },
    ]);
  });

  it("missing required columns", () => {
    expect(normalizeRows([["date", "staff_code"]]).errors).toEqual(["missing column: location_code", "missing column: shift"]);
  });
});
