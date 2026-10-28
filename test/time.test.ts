import { describe, it, expect } from "vitest";
import { addDays, bangkokDateOf, bangkokInstant } from "../src/time";

describe("Bangkok time model", () => {
  it("06:30 Bangkok is 23:30 UTC the previous day", () => {
    expect(bangkokInstant("2026-03-01", "06:30")).toBe(Date.UTC(2026, 1, 28, 23, 30));
  });
  it("the Bangkok date flips at 17:00 UTC, not midnight UTC", () => {
    expect(bangkokDateOf(Date.UTC(2026, 1, 28, 16, 59))).toBe("2026-02-28");
    expect(bangkokDateOf(Date.UTC(2026, 1, 28, 17, 0))).toBe("2026-03-01");
    expect(bangkokDateOf(Date.UTC(2026, 1, 28, 23, 30))).toBe("2026-03-01");
  });
  it("day offsets cross month, year and leap-day boundaries", () => {
    expect(bangkokInstant("2026-03-01", "16:00", -1)).toBe(Date.UTC(2026, 1, 28, 9, 0));
    expect(bangkokInstant("2027-01-01", "16:00", -1)).toBe(Date.UTC(2026, 11, 31, 9, 0));
    expect(bangkokInstant("2028-03-01", "16:00", -1)).toBe(Date.UTC(2028, 1, 29, 9, 0));
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});
