import { beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock";
import { FakeEmailClient } from "../src/email";
import { FakeLineClient } from "../src/line-fake";
import { runScheduler } from "../src/scheduler";
import { applySchedule } from "../src/settings";
import { admin, at, call, D, db, dutyId, envExtra, LIFF, MIN, SITE, standardDay, token } from "./helpers";

// The check-in confirmation is an email receipt to the member's roster email (no LINE quota).
const URL_ = "https://duty.school.test";
let line: FakeLineClient, mail: FakeEmailClient, clock: FixedClock;
const IN = { lat: SITE.lat, lng: SITE.lng, accuracy: 10 };
async function checkIn(n = 1, pos = IN) {
  const s = (await (await call(line, clock, "POST", "/api/checkin/start", { idToken: token(n) })).json()) as any;
  return (await (await call(line, clock, "POST", "/api/checkin/submit",
    { idToken: token(n), dutyId: s.current.dutyId, nonce: s.current.nonce, clientTs: clock.now(), ...pos })).json()) as any;
}
const confirms = async () => (await db.prepare("SELECT * FROM outbox WHERE kind = 'CONFIRM' ORDER BY id").all<any>()).results;

beforeEach(async () => {
  await standardDay();
  await db.batch([1, 2, 3, 4].map((i) => db.prepare("UPDATE members SET email = ? WHERE id = ?").bind(`person${i}@school.test`, i)));
  line = new FakeLineClient();
  mail = new FakeEmailClient();
  envExtra.EMAIL = mail;
  envExtra.PUBLIC_URL = URL_;
  clock = new FixedClock(at(D, "06:40"));
});

describe("check-in receipt (email)", () => {
  it("a successful check-in emails one receipt right away, in Thai by default, and pushes nothing to LINE", async () => {
    const r = await checkIn(1);
    expect(r).toMatchObject({ result: "ok", confirmQueued: true });
    expect(line.sent.length).toBe(0);
    expect(mail.sent.length).toBe(1);
    const m = mail.sent[0];
    expect(m.to).toBe("person1@school.test");
    expect(m.subject).toMatch(/^ใบยืนยันเช็กอิน: เวร AM /);
    expect(m.text).toContain("สมาชิก: Person 1 (S001)");
    expect(m.text).toContain("เช็กอินเวลา: 06:40 น. (ตรงเวลา)");
    expect(m.text).toContain("จุดเวร: Site GATE");
    expect(m.text).toMatch(/เลขที่: SKD-\d+-[0-9A-Z]+/);
    expect(m.text).toContain(`${URL_}/me`);
    expect((await confirms())[0]).toMatchObject({ channel: "email", status: "API_ACCEPTED", dedupe_key: `EC:${await dutyId(1)}` });
  });

  it("the receipt has an HTML part: escaped values, the emblem, a link to the member page, the shift's display name", async () => {
    await db.prepare("UPDATE locations SET name = ? WHERE code = 'GATE'").bind('Gate <b>"1"</b> & co').run();
    applySchedule({ shifts: [{ code: "AM", name: "Morning gate", start: "06:30", end: "12:00" }, { code: "PM", name: "", start: "14:20", end: "18:00" }] });
    await checkIn(1);
    const { html, text, subject } = mail.sent[0];
    expect(subject).toContain("Morning gate");
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("Gate &lt;b&gt;&quot;1&quot;&lt;/b&gt; &amp; co");
    expect(html).not.toContain("<b>");
    expect(html).toContain(`src="${URL_}/brand/emblem-96.png"`);
    expect(html).toContain(`href="${URL_}/me"`);
    expect(html).toContain("ตรงเวลา");
    expect(text).toContain('Gate <b>"1"</b> & co'); // the text part is plain
  });

  it("late check-in says late; English when the setting says so", async () => {
    applySchedule({ messageLanguage: "en" });
    clock.set(at(D, "07:05"));
    await checkIn(2);
    expect(mail.sent[0].subject).toMatch(/^Check-in receipt: AM duty, /);
    expect(mail.sent[0].text).toContain("Checked in: 07:05 (late)");
    expect(mail.sent[0].text).toContain("Method: location check (GPS)");
  });

  it("never twice: a double submit queues nothing new", async () => {
    await checkIn(1);
    await call(line, clock, "POST", "/api/checkin/submit", { idToken: token(1), dutyId: await dutyId(1), nonce: "x", ...IN });
    expect((await confirms()).length).toBe(1);
    expect(mail.sent.length).toBe(1);
  });

  it("failed attempts send nothing", async () => {
    expect((await checkIn(1, { ...IN, lat: SITE.lat + 0.01 })).result).toBe("outside_geofence");
    expect(mail.sent.length).toBe(0);
    expect((await confirms()).length).toBe(0);
  });

  it("no roster email: no receipt row", async () => {
    expect((await checkIn(5)).result).toBe("ok");
    expect((await confirms()).length).toBe(0);
  });

  it("if the mail server fails, the scheduler retries the same row with the same Message-ID", async () => {
    mail.next = [{ kind: "temporary", message: "421 busy" }];
    await checkIn(1);
    const [row] = await confirms();
    expect(row.status).toBe("RETRY_WAIT");
    clock.advance(2 * MIN);
    await runScheduler({ db, clock, line, liffId: LIFF, email: mail, publicUrl: URL_, rand: () => 0.5 });
    expect((await confirms())[0].status).toBe("API_ACCEPTED");
    expect(mail.sent.filter((m) => m.messageId === `<${row.retry_key}@duty.school.test>`).length).toBe(1);
  });

  it("the sweep does not suppress receipts (unlike prompts) because the duty is checked in", async () => {
    mail.next = [{ kind: "temporary", message: "421 busy" }];
    await checkIn(1);
    await runScheduler({ db, clock, line: undefined }); // sweep only
    expect((await confirms())[0].status).toBe("RETRY_WAIT");
  });

  it("switched off in settings: nothing is queued or sent", async () => {
    applySchedule({ confirmOnCheckin: false });
    expect((await checkIn(1)).confirmQueued).toBe(false);
    expect(mail.sent.length).toBe(0);
  });

  it("a coordinator override also sends a receipt, marked as recorded by a coordinator", async () => {
    await admin(line, clock, "POST", `/admin/api/duties/${await dutyId(3)}/override`, { note: "GPS failed indoors" });
    expect(mail.sent.map((m) => m.to)).toEqual(["person3@school.test"]);
    expect(mail.sent[0].text).toContain("วิธี: บันทึกโดยผู้ดูแล");
    expect(line.sent.length).toBe(0);
  });

  it("sent during quiet hours too (it answers what the member just did)", async () => {
    // A custom evening duty 20:30-23:00, checked in at 21:30 (inside 21:00-06:00 quiet hours).
    await db.prepare("UPDATE duties SET start_at = ?, end_at = ? WHERE id = ?").bind(at(D, "20:30"), at(D, "23:00"), await dutyId(4, "PM")).run();
    await db.prepare("UPDATE duties SET status = 'CHECKED_IN' WHERE id = ?").bind(await dutyId(4, "AM")).run();
    clock.set(at(D, "21:30"));
    expect((await checkIn(4)).result).toBe("ok");
    expect(mail.sent.length).toBe(1);
  });
});
