import { beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock";
import { FakeEmailClient } from "../src/email";
import { FakeLineClient } from "../src/line-fake";
import { runScheduler } from "../src/scheduler";
import { applySchedule } from "../src/settings";
import { admin, at, D, db, dutyId, envExtra, LIFF, MIN, standardDay } from "./helpers";

const URL_ = "https://duty.school.test";
let line: FakeLineClient, mail: FakeEmailClient, clock: FixedClock;
const tick = (extra: Partial<Parameters<typeof runScheduler>[0]> = {}) =>
  runScheduler({ db, clock, line, liffId: LIFF, email: mail, publicUrl: URL_, rand: () => 0.5, ...extra });
const rows = async (where = "1=1") => (await db.prepare(`SELECT * FROM outbox WHERE ${where} ORDER BY id`).all<Record<string, any>>()).results;

beforeEach(async () => {
  // Members 1..10; 1-3 have a roster email; 2 and 3 are not linked to LINE.
  await standardDay({ unlinked: [2, 3] });
  await db.batch([1, 2, 3].map((i) => db.prepare("UPDATE members SET email = ? WHERE id = ?").bind(`person${i}@school.test`, i)));
  line = new FakeLineClient();
  mail = new FakeEmailClient();
  clock = new FixedClock(at(D, "15:00", -1));
});

describe("email notifications", () => {
  it("off by default: no email rows", async () => {
    await tick();
    expect((await rows("channel = 'email'")).length).toBe(0);
  });

  it("fallback: email rows only for members with an email and no LINE link", async () => {
    applySchedule({ emailMode: "fallback" });
    await tick();
    const e = await rows("channel = 'email'");
    expect(new Set(e.map((r) => r.member_id))).toEqual(new Set([2, 3]));
    expect(e.filter((r) => r.kind === "REMINDER").map((r) => r.dedupe_key).sort()).toEqual([`ER:2:${D}`, `ER:3:${D}`]);
    expect(e.filter((r) => r.kind === "PROMPT").length).toBe(4);
    await tick(); // idempotent
    expect((await rows("channel = 'email'")).length).toBe(e.length);
  });

  it("all: everyone with an email, alongside LINE; switching it on later plans the missing email rows", async () => {
    await tick();
    applySchedule({ emailMode: "all" });
    await tick();
    expect(new Set((await rows("channel = 'email'")).map((r) => r.member_id))).toEqual(new Set([1, 2, 3]));
    expect((await rows("channel = 'line'")).length).toBe(50);
  });

  it("sends the reminder at 16:00 the day before, with a link to the member portal, never twice", async () => {
    applySchedule({ emailMode: "fallback" });
    await tick();
    clock.set(at(D, "16:00", -1));
    await tick();
    expect(mail.sent.map((m) => m.to).sort()).toEqual(["person2@school.test", "person3@school.test"]);
    const m = mail.sent[0];
    expect(m.subject).toContain("แจ้งเตือนเวร");
    expect(m.text).toContain(`${URL_}/me`);
    expect(m.messageId).toMatch(/^<[0-9a-f-]{36}@duty\.school\.test>$/);
    const r = (await rows(`dedupe_key = 'ER:2:${D}'`))[0];
    expect(r).toMatchObject({ status: "API_ACCEPTED", target_user_id: "person2@school.test" });
    await tick();
    expect(mail.sent.length).toBe(2);
  });

  it("temporary failure retries with the same Message-ID; a permanent failure is final", async () => {
    applySchedule({ emailMode: "fallback" });
    await tick();
    clock.set(at(D, "16:00", -1));
    mail.next = [{ kind: "temporary", message: "421 try later" }, { kind: "permanent", message: "550 no such user" }];
    await tick();
    const [a, b] = await rows("channel = 'email' AND kind = 'REMINDER'");
    expect(a).toMatchObject({ status: "RETRY_WAIT", attempts: 1 });
    expect(a.last_error).toContain("smtp_temporary");
    expect(b).toMatchObject({ status: "FAILED" });
    expect(b.last_error).toContain("smtp_permanent: 550");
    clock.set(clock.now() + 2 * MIN);
    await tick();
    const again = (await rows(`id = ${a.id}`))[0];
    expect(again.status).toBe("API_ACCEPTED");
    expect(mail.sent.at(-1)!.messageId).toBe(`<${again.retry_key}@duty.school.test>`);
  });

  it("email goes out without LINE configured; LINE rows wait", async () => {
    applySchedule({ emailMode: "all" });
    await tick({ line: undefined });
    clock.set(at(D, "16:00", -1));
    await tick({ line: undefined });
    expect(mail.sent.length).toBe(3);
    expect((await rows("channel = 'line' AND status = 'API_ACCEPTED'")).length).toBe(0);
  });

  it("prompt is suppressed once checked in (same rule as LINE)", async () => {
    applySchedule({ emailMode: "fallback" });
    clock.set(at(D, "06:00"));
    await tick();
    await db.prepare("UPDATE duties SET status = 'CHECKED_IN', checked_in_at = ? WHERE id = ?").bind(clock.now(), await dutyId(2)).run();
    clock.set(at(D, "06:30"));
    await tick();
    expect((await rows(`dedupe_key = 'EP:${await dutyId(2)}'`))[0].status).toBe("SUPPRESSED");
    expect(mail.sent.some((m) => m.to === "person3@school.test" && m.subject.includes("AM"))).toBe(true);
  });

  it("override receipt: email, no LINE row", async () => {
    applySchedule({ emailMode: "fallback" });
    envExtra.EMAIL = mail;
    envExtra.PUBLIC_URL = URL_;
    clock.set(at(D, "07:10"));
    const id = await dutyId(2);
    expect((await admin(line, clock, "POST", `/admin/api/duties/${id}/override`, { note: "GPS broken" })).status).toBe(200);
    expect((await rows("kind = 'CONFIRM'")).map((r) => [r.channel, r.dedupe_key, r.status])).toEqual([["email", `EC:${id}`, "API_ACCEPTED"]]);
    expect(mail.sent[0].subject).toMatch(/^ใบยืนยันเช็กอิน: เวร AM /);
  });

  it("settings: email mode saved; test email goes to the admin's own address", async () => {
    const s = (await (await admin(line, clock, "GET", "/admin/api/settings")).json()) as any;
    expect(s.emailConfigured).toBe(false);
    expect((await admin(line, clock, "POST", "/admin/api/email/test")).status).toBe(503);
    expect((await admin(line, clock, "POST", "/admin/api/settings", { ...s.schedule, emailMode: "bogus" })).status).toBe(400);
    expect((await admin(line, clock, "POST", "/admin/api/settings", { ...s.schedule, emailMode: "all" })).status).toBe(200);
    envExtra.EMAIL = mail;
    envExtra.PUBLIC_URL = URL_;
    expect(((await (await admin(line, clock, "GET", "/admin/api/settings")).json()) as any).emailConfigured).toBe(true);
    expect((await admin(line, clock, "POST", "/admin/api/email/test")).status).toBe(400); // test admin has no email
    await db.prepare("UPDATE admin_users SET email = 'ops@school.test' WHERE id = 1").run();
    expect((await admin(line, clock, "POST", "/admin/api/email/test")).status).toBe(200);
    expect(mail.sent.map((m) => m.to)).toEqual(["ops@school.test"]);
  });
});
