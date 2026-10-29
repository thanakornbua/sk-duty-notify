import { describe, expect, it } from "vitest";
import { haversineM, nearestPoint } from "../src/geo";
import { addDays, afterQuietHours, bangkokDateOf, bangkokInstant, bangkokTimeOf, dateLabel, inQuietHours } from "../src/time";

describe("Bangkok time model", () => {
  it("06:30 Bangkok is 23:30 UTC the previous day; the duty date stays the Bangkok date", () => {
    const t = bangkokInstant("2026-03-02", "06:30");
    expect(new Date(t).toISOString()).toBe("2026-03-01T23:30:00.000Z");
    expect(bangkokDateOf(t)).toBe("2026-03-02");
    expect(bangkokTimeOf(t)).toBe("06:30");
  });

  it("day offsets and month/year rollover", () => {
    expect(bangkokDateOf(bangkokInstant("2026-03-01", "16:00", -1))).toBe("2026-02-28");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(dateLabel("2026-03-02")).toBe("Mon 2 Mar 2026");
  });

  it("quiet hours wrap midnight and push sends to 06:00", () => {
    expect(inQuietHours(bangkokInstant("2026-03-02", "20:59"))).toBe(false);
    expect(inQuietHours(bangkokInstant("2026-03-02", "21:00"))).toBe(true);
    expect(inQuietHours(bangkokInstant("2026-03-02", "05:59"))).toBe(true);
    expect(inQuietHours(bangkokInstant("2026-03-02", "06:00"))).toBe(false);
    expect(afterQuietHours(bangkokInstant("2026-03-02", "22:00"))).toBe(bangkokInstant("2026-03-03", "06:00"));
    expect(afterQuietHours(bangkokInstant("2026-03-02", "03:00"))).toBe(bangkokInstant("2026-03-02", "06:00"));
  });
});

describe("geofence maths", () => {
  it("haversine: 0.001 deg latitude is about 111 m", () => {
    expect(haversineM(13.75, 100.5, 13.751, 100.5)).toBeCloseTo(111.2, 0);
    expect(haversineM(13.75, 100.5, 13.75, 100.5)).toBe(0);
  });

  it("inside ANY point passes; reports the point that passes", () => {
    const pts = [{ id: 1, lat: 13.75, lng: 100.5, radius_m: 50 }, { id: 2, lat: 13.752, lng: 100.5, radius_m: 100 }];
    const near = nearestPoint(13.7515, 100.5, pts)!; // 167 m from #1, 56 m from #2
    expect(near.inside).toBe(true);
    expect(near.point.id).toBe(2);
    expect(nearestPoint(13.76, 100.5, pts)!.inside).toBe(false);
    expect(nearestPoint(0, 0, [])).toBeNull();
  });
});
