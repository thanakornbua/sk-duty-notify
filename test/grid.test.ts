import { describe, it, expect } from "vitest";
import { parseGrid, parseDateCell, serialToDate } from "../public/grid.js";

const serial1900 = (y: number, m: number, d: number) => (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
const serial1904 = (y: number, m: number, d: number) => (Date.UTC(y, m - 1, d) - Date.UTC(1904, 0, 1)) / 86400000;

describe("date cells", () => {
  it("reads Excel serials in the 1900 system", () => {
    expect(serialToDate(46082)).toBe("2026-03-01");
    expect(serialToDate(serial1900(2026, 12, 31))).toBe("2026-12-31");
    expect(serialToDate(serial1900(2028, 2, 29))).toBe("2028-02-29");
  });
  it("reads Excel serials in the 1904 system (1462 days earlier)", () => {
    expect(serialToDate(44620, true)).toBe("2026-03-01");
    expect(serialToDate(serial1904(2026, 3, 1), true)).toBe("2026-03-01");
    // The same number means a different date in the other system.
    expect(serialToDate(44620, false)).not.toBe("2026-03-01");
  });
  it("rejects the nonexistent 1900-02-29 serial and junk", () => {
    expect(serialToDate(60)).toBeNull();
    expect(serialToDate(0)).toBeNull();
    expect(serialToDate(NaN)).toBeNull();
  });
  it("converts Buddhist-era years (serials and strings)", () => {
    expect(serialToDate(serial1900(2569, 3, 1))).toBe("2026-03-01");
    expect(serialToDate(serial1904(2569, 3, 1), true)).toBe("2026-03-01");
    expect(parseDateCell("01/03/2569")).toBe("2026-03-01");
    expect(parseDateCell("2569-03-01")).toBe("2026-03-01");
  });
  it("parses day-first and ISO strings, rejects impossible dates", () => {
    expect(parseDateCell("1/3/2026")).toBe("2026-03-01");
    expect(parseDateCell("2026-03-01")).toBe("2026-03-01");
    expect(parseDateCell("31/02/2026")).toBeNull();
    expect(parseDateCell("hello")).toBeNull();
    expect(parseDateCell("01/03/1999")).toBeNull();
  });
  it("handles month and year rollover without off-by-one", () => {
    expect(serialToDate(serial1900(2026, 12, 31))).toBe("2026-12-31");
    expect(serialToDate(serial1900(2027, 1, 1))).toBe("2027-01-01");
  });
});

const header = (...dates: unknown[]) => ["", ...dates];

describe("parseGrid", () => {
  it("normalizes a simple grid", () => {
    const res = parseGrid([header(46082, 46083), ["P1", "S001", "S002"], ["P2", "S003", "S004"]]);
    expect(res).toEqual({
      ok: true,
      data: { days: [
        { date: "2026-03-01", assignments: [{ position: "P1", staffId: "S001" }, { position: "P2", staffId: "S003" }] },
        { date: "2026-03-02", assignments: [{ position: "P1", staffId: "S002" }, { position: "P2", staffId: "S004" }] },
      ] },
    });
  });
  it("honours date1904", () => {
    const res = parseGrid([header(44620), ["P1", "S001"]], { date1904: true });
    expect(res.ok && res.data.days[0].date).toBe("2026-03-01");
  });
  it("treats a fully empty date column as an explicit NO_DUTY day", () => {
    const res = parseGrid([header(46082), ["P1", null], ["P2", ""]]);
    expect(res).toEqual({ ok: true, data: { days: [{ date: "2026-03-01", assignments: [] }] } });
  });
  it("rejects merged cells in the data area but not in the corner", () => {
    const bad = parseGrid([header(46082), ["P1", "S001"]], { merges: [{ s: { r: 1, c: 1 }, e: { r: 2, c: 1 } }] });
    expect(bad.ok).toBe(false);
    const cornerOnly = parseGrid([header(46082), ["P1", "S001"]], { merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 0 } }] });
    expect(cornerOnly.ok).toBe(true);
  });
  it("rejects duplicate dates, unreadable dates, and duplicate positions", () => {
    expect(parseGrid([header(46082, 46082), ["P1", "S001", "S002"]]).ok).toBe(false);
    expect(parseGrid([header("soon"), ["P1", "S001"]]).ok).toBe(false);
    expect(parseGrid([header(46082), ["P1", "S001"], ["P1", "S002"]]).ok).toBe(false);
  });
  it("rejects data without a date header or without a position label", () => {
    expect(parseGrid([header(46082, null), ["P1", "S001", "S002"]]).ok).toBe(false);
    expect(parseGrid([header(46082), [null, "S001"]]).ok).toBe(false);
  });
  it("rejects a sheet that is too small", () => {
    expect(parseGrid([]).ok).toBe(false);
    expect(parseGrid([["x"]]).ok).toBe(false);
  });
});
