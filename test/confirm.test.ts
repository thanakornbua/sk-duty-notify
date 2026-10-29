import { beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock";
import { FakeLineClient } from "../src/line-fake";
import { runScheduler } from "../src/scheduler";
import { applySchedule } from "../src/settings";
import { admin, at, call, D, db, dutyId, LIFF, MIN, SITE, standardDay, token } from "./helpers";

let line: FakeLineClient, clock: FixedClock;
const IN = { lat: SITE.lat, lng: SITE.lng, accuracy: 10 };
async function checkIn(n = 1, pos = IN) {
  const s = (await (await call(line, clock, "POST", "/api/checkin/start", { idToken: token(n) })).json()) as any;
  return (await (await call(line, clock, "POST", "/api/checkin/submit",
    { idToken: token(n), dutyId: s.current.dutyId, nonce: s.current.nonce, clientTs: clock.now(), ...pos })).json()) as any;
}
const confirms = async () => (await db.prepare("SELECT * FROM outbox WHERE kind = 'CONFIRM' ORDER BY id").all<any>()).results;
const sentTexts = () => line.sent.map((s) => String(s.messages[0].text ?? ""));

beforeEach(async () => { await standardDay(); line = new FakeLineClient(); clock = new FixedClock(at(D, "06:40")); });

describe("check-in confirmation message", () => {
  it("a successful check-in sends one confirmation right away (no cron wait), in Thai by default", async () => {
    const r = await checkIn(1);
    expect(r).toMatchObject({ result: "ok", confirmQueued: true });
    expect(line.sent.length).toBe(1);
    expect(line.sent[0].to).toBe("U001");
    expect(sentTexts()[0]).toBe("✅ เช็กอินเวร AM สำเร็จ เวลา 06:40 น. (ตรงเวลา) ที่ Site GATE");
    expect((await confirms())[0]).toMatchObject({ status: "API_ACCEPTED", dedupe_key: `C:${await dutyId(1)}` });
  });

  it("late check-in says late; English when the setting says so", async () => {
    applySchedule({ messageLanguage: "en" });
    clock.set(at(D, "07:05"));
    await checkIn(2);
    expect(sentTexts()[0]).toBe("✅ Checked in for AM duty at 07:05 (late), Site GATE.");
  });

  it("never twice: a double submit queues nothing new", async () => {
    await checkIn(1);
    await call(line, clock, "POST", "/api/checkin/submit", { idToken: token(1), dutyId: await dutyId(1), nonce: "x", ...IN });
    expect((await confirms()).length).toBe(1);
    expect(line.sent.length).toBe(1);
  });

  it("failed attempts send nothing", async () => {
    expect((await checkIn(1, { ...IN, lat: SITE.lat + 0.01 })).result).toBe("outside_geofence");
    expect(line.sent.length).toBe(0);
    expect((await confirms()).length).toBe(0);
  });

  it("if LINE fails right away, the scheduler retries the same row with the same key", async () => {
    line.inject({ kind: "server_error" });
    await checkIn(1);
    const [row] = await confirms();
    expect(row.status).toBe("RETRY_WAIT");
    clock.advance(2 * MIN);
    await runScheduler({ db, clock, line, liffId: LIFF, rand: () => 0.5 });
    expect((await confirms())[0].status).toBe("API_ACCEPTED");
    // Two attempts on the confirmation's own pinned key (the run also sends the day's other planned messages).
    expect(line.calls.filter((c) => c.retryKey === row.retry_key).length).toBe(2);
    expect(line.sent.filter((s) => s.retryKey === row.retry_key).length).toBe(1);
  });

  it("the sweep does not suppress confirmations (unlike prompts) because the duty is checked in", async () => {
    line.inject({ kind: "server_error" });
    await checkIn(1);
    await runScheduler({ db, clock, line: undefined }); // sweep only
    expect((await confirms())[0].status).toBe("RETRY_WAIT");
  });

  it("switched off in settings: nothing is queued or sent", async () => {
    applySchedule({ confirmOnCheckin: false });
    expect((await checkIn(1)).confirmQueued).toBe(false);
    expect(line.sent.length).toBe(0);
  });

  it("a coordinator override also confirms to the member", async () => {
    await admin(line, clock, "POST", `/admin/api/duties/${await dutyId(3)}/override`, { note: "GPS failed indoors" });
    expect(line.sent.map((s) => s.to)).toEqual(["U003"]);
  });

  it("sent during quiet hours too (it answers what the member just did)", async () => {
    // A custom evening duty 20:30-23:00, checked in at 21:30 (inside 21:00-06:00 quiet hours).
    await db.prepare("UPDATE duties SET start_at = ?, end_at = ? WHERE id = ?").bind(at(D, "20:30"), at(D, "23:00"), await dutyId(4, "PM")).run();
    await db.prepare("UPDATE duties SET status = 'CHECKED_IN' WHERE id = ?").bind(await dutyId(4, "AM")).run();
    clock.set(at(D, "21:30"));
    expect((await checkIn(4)).result).toBe("ok");
    expect(line.sent.length).toBe(1);
  });
});
