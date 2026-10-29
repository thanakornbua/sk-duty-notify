import { beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock";
import { config } from "../src/config";
import { FakeLineClient } from "../src/line-fake";
import { buildMessages, LIMITS } from "../src/messages";
import { claim, runScheduler } from "../src/scheduler";
import { applySchedule } from "../src/settings";
import { addDays, bangkokDateOf } from "../src/time";
import { amPm, at, D, db, dutyId, LIFF, MIN, publishRows, reset, seedLocation, seedMembers, standardDay } from "./helpers";

let line: FakeLineClient, clock: FixedClock;
const tick = (extra: Partial<Parameters<typeof runScheduler>[0]> = {}) =>
  runScheduler({ db, clock, line, liffId: LIFF, rand: () => 0.5, ...extra });
const drain = async () => { for (let i = 0; i < 20; i++) if (!(await tick()).claimed) return; };
const rows = async (where = "1=1") => (await db.prepare(`SELECT * FROM outbox WHERE ${where} ORDER BY id`).all<Record<string, any>>()).results;
const texts = () => line.sent.map((s) => JSON.stringify(s.messages));

describe("outbox planning", () => {
  beforeEach(async () => { await standardDay(); line = new FakeLineClient(); clock = new FixedClock(at(D, "15:00", -1)); });

  it("plans one reminder per member per day, one prompt and one missed per duty, for today and tomorrow only", async () => {
    await publishRows(amPm([addDays(D, 2)], 10));
    await tick({ line: undefined });
    const all = await rows();
    expect(all.filter((r) => r.kind === "REMINDER").length).toBe(10);
    expect(all.filter((r) => r.kind === "PROMPT").length).toBe(20);
    expect(all.filter((r) => r.kind === "MISSED").length).toBe(20);
    expect(new Set(all.map((r) => r.duty_date))).toEqual(new Set([D])); // D+2 not yet
    const r = all.find((x) => x.kind === "REMINDER")!;
    expect(r.due_at).toBe(at(D, "16:00", -1));
    expect(r.deadline_at).toBe(at(D, "06:30"));
    const m = all.find((x) => x.kind === "MISSED")!;
    expect(m.due_at).toBe(at(D, "07:00"));
  });

  it("planning is idempotent across runs (unique dedupe keys)", async () => {
    await tick({ line: undefined });
    await tick({ line: undefined });
    expect((await rows()).length).toBe(50);
  });

  it("tomorrow is the calendar day: planned on D-1 even though nothing is on D-1", async () => {
    expect(bangkokDateOf(clock.now())).toBe(addDays(D, -1));
    expect((await tick({ line: undefined })).planned).toBe(20);
  });
});

describe("sending", () => {
  // English copy here; the Thai copy has its own test below.
  beforeEach(async () => { await standardDay(); applySchedule({ messageLanguage: "en" }); line = new FakeLineClient(); clock = new FixedClock(at(D, "15:00", -1)); });

  it("Thai copy (the default): Thai date with Buddhist year, Thai button label", async () => {
    applySchedule({});
    clock.set(at(D, "16:00", -1)); await tick(); await drain();
    const t = line.sent[0].messages[0].text as string;
    expect(t).toContain("วันจันทร์ที่ 2 มีนาคม พ.ศ. 2569");
    expect(t).toMatch(/• AM 06:30–12:00 น\. ที่ Site GATE/);
    clock.set(at(D, "06:30")); await tick(); await drain();
    const prompt = line.sent.find((s) => s.messages[0].type === "template")!.messages[0] as any;
    expect(prompt.template.actions[0].label).toBe("เช็กอิน");
    expect(prompt.template.text).toMatch(/^เวร AM เริ่ม 06:30 น\./);
  });

  it("16:00 the day before: one reminder per member listing both shifts", async () => {
    await tick();
    expect(line.sent.length).toBe(0);
    clock.set(at(D, "16:00", -1));
    const s = await tick();
    expect(s.claimed).toBe(config.batchSize);
    await drain();
    expect(line.sent.length).toBe(10);
    const t = line.sent[0].messages[0].text as string;
    expect(t).toContain("Mon 2 Mar 2026");
    expect(t).toMatch(/AM 06:30–12:00 at Site GATE/);
    expect(t).toMatch(/PM 14:20–18:00 at Site GATE/);
    expect(new Set(line.sent.map((s) => s.to)).size).toBe(10);
    const r = (await rows("kind = 'REMINDER'"))[0];
    expect(r.status).toBe("API_ACCEPTED");
    expect(r.accepted_at).toBe(clock.now());
    expect(r.line_request_id).toMatch(/^fake-req-/);
  });

  it("prompt at duty start opens the LIFF check-in page; the URL carries no duty id", async () => {
    clock.set(at(D, "06:30"));
    await tick(); await drain();
    const prompts = line.sent.filter((s) => s.messages[0].type === "template");
    expect(prompts.length).toBe(10);
    const action = (prompts[0].messages[0] as any).template.actions[0];
    expect(action).toEqual({ type: "uri", label: "Check in", uri: `https://liff.line.me/${LIFF}/checkin` });
  });

  it("missed message only for members still PENDING; checked-in members get nothing more", async () => {
    clock.set(at(D, "06:30"));
    await tick(); await drain();
    await db.prepare("UPDATE duties SET status = 'CHECKED_IN', checked_in_at = ? WHERE id IN (?, ?)").bind(clock.now(), await dutyId(1), await dutyId(2)).run();
    const before = line.sent.length;
    clock.set(at(D, "07:00"));
    await tick(); await drain();
    const missed = line.sent.slice(before);
    expect(missed.length).toBe(8);
    expect(missed.every((m) => /not checked in/.test(JSON.stringify(m.messages)))).toBe(true);
    expect(missed.map((m) => m.to)).not.toContain("U001");
    expect((await rows("kind = 'MISSED' AND status = 'SUPPRESSED'")).length).toBe(2);
    clock.set(at(D, "07:30")); await tick(); await drain();
    expect(line.sent.length).toBe(before + 8); // never repeated
  });

  it("early check-in suppresses the prompt itself", async () => {
    await db.prepare("UPDATE duties SET status = 'CHECKED_IN' WHERE id = ?").bind(await dutyId(3)).run();
    clock.set(at(D, "06:30")); await tick(); await drain();
    expect(line.sent.filter((s) => s.to === "U003" && s.messages[0].type === "template").length).toBe(0);
  });

  it("payloads respect LINE limits", () => {
    const long = "L".repeat(300);
    for (const kind of ["PROMPT", "MISSED"] as const) {
      const [m] = buildMessages(kind, D, [{ shift: "AM", start_at: at(D, "06:30"), end_at: at(D, "12:00"), location: long }], LIFF) as any[];
      expect(m.template.text.length).toBeLessThanOrEqual(LIMITS.buttonsText);
      expect(m.altText.length).toBeLessThanOrEqual(LIMITS.altText);
      expect(m.template.actions[0].label.length).toBeLessThanOrEqual(LIMITS.label);
    }
  });

  it("without a LIFF id nothing is claimed (and rows are not consumed)", async () => {
    clock.set(at(D, "06:30"));
    expect((await tick({ liffId: undefined })).claimed).toBe(0);
    expect(line.calls.length).toBe(0);
  });
});

describe("never twice, even after a restart", () => {
  beforeEach(async () => {
    await reset(); await seedMembers(1); await seedLocation();
    await publishRows([{ date: D, staffCode: "S001", locationCode: "GATE", shift: "AM" }]);
    line = new FakeLineClient(); clock = new FixedClock(at(D, "06:30"));
    await tick({ line: undefined });
    await db.prepare("UPDATE outbox SET status = 'CANCELLED' WHERE kind != 'PROMPT'").run();
  });

  it("response lost after LINE accepted: retry reuses the key, 409 maps to the original request", async () => {
    line.inject({ kind: "timeout_after_accept" });
    await tick();
    const [r1] = await rows("kind = 'PROMPT'");
    expect(r1.status).toBe("RETRY_WAIT");
    clock.advance(2 * MIN);
    await tick();
    const [r2] = await rows("kind = 'PROMPT'");
    expect(r2.status).toBe("API_ACCEPTED");
    expect(line.sent.length).toBe(1);
    expect(line.calls.map((c) => c.retryKey)).toEqual([r1.retry_key, r1.retry_key]);
    expect(r2.line_request_id).toBe(line.sent[0].requestId);
  });

  it("worker dies mid-send: the lease expires, the row is retried with the same pinned key", async () => {
    const [claimed] = await claim(db, "dead-worker", clock.now(), 10); // only the PROMPT is still QUEUED
    await db.prepare("UPDATE outbox SET retry_key = 'pinned-key', payload = '[{\"type\":\"text\",\"text\":\"x\"}]', target_user_id = 'U001', attempts = 1 WHERE id = ?").bind(claimed.id).run();
    expect((await tick()).claimed).toBe(0); // still leased
    clock.advance(config.leaseSeconds * 1000);
    const s = await tick();
    expect(s.reaped).toBe(1);
    expect(line.calls.map((c) => c.retryKey)).toEqual(["pinned-key"]);
    expect((await rows("kind = 'PROMPT'"))[0].status).toBe("API_ACCEPTED");
  });

  it("two schedulers at once never share a row", async () => {
    const [a, b] = await Promise.all([claim(db, "A", clock.now(), 10), claim(db, "B", clock.now(), 10)]);
    expect(a.length + b.length).toBe(1);
  });

  it("an accepted row is never sent again", async () => {
    await tick(); await tick(); clock.advance(10 * MIN); await tick();
    expect(line.calls.length).toBe(1);
  });
});

describe("failures", () => {
  beforeEach(async () => {
    await reset(); await seedMembers(2, { unlinked: [2] }); await seedLocation();
    await publishRows([{ date: D, staffCode: "S001", locationCode: "GATE", shift: "AM" }]);
    line = new FakeLineClient(); clock = new FixedClock(at(D, "06:30"));
    await tick({ line: undefined });
    await db.prepare("UPDATE outbox SET status = 'CANCELLED' WHERE kind != 'PROMPT'").run();
  });
  const prompt = async () => (await rows("kind = 'PROMPT'"))[0];

  it("429 honours Retry-After", async () => {
    line.inject({ kind: "rate_limited", retryAfterSeconds: 90 });
    await tick();
    expect((await prompt()).next_attempt_at).toBe(clock.now() + 90_000);
  });

  it("5xx backs off 1, 2, 5, 10 min then fails at max attempts", async () => {
    line.rule = () => ({ kind: "server_error", status: 503 });
    const waits: number[] = [];
    for (let i = 0; i < config.maxAttempts; i++) {
      await tick();
      const p = await prompt();
      if (p.status === "RETRY_WAIT") { waits.push((p.next_attempt_at - clock.now()) / MIN); clock.set(p.next_attempt_at); }
    }
    expect(waits).toEqual([1, 2, 5, 10]);
    expect(await prompt()).toMatchObject({ status: "FAILED", attempts: 5 });
    expect((await prompt()).last_error).toMatch(/max_attempts: server_error_503/);
  });

  it("4xx is terminal with a visible error", async () => {
    line.inject({ kind: "client_error", status: 400, message: "Invalid reply token" });
    await tick();
    expect(await prompt()).toMatchObject({ status: "FAILED", last_error: "http_400: Invalid reply token" });
  });

  it("409 without any known accepted request id is not treated as accepted", async () => {
    line.inject({ kind: "conflict" });
    await tick();
    expect(await prompt()).toMatchObject({ status: "FAILED", last_error: "duplicate_retry_key_without_accepted_request_id" });
  });

  it("a retry never lands after the deadline (duty end)", async () => {
    clock.set(at(D, "11:59") + 30_000); // 1 min backoff would land at 12:00:30, after the 12:00 end
    line.inject({ kind: "server_error" });
    await tick();
    expect((await prompt()).status).toBe("FAILED");
    expect((await prompt()).last_error).toMatch(/deadline_passed/);
  });

  it("unlinked member: waits for linking, then fails visibly at the deadline", async () => {
    await publishRows([{ date: D, staffCode: "S002", locationCode: "GATE", shift: "AM" }]);
    await tick({ line: undefined });
    await db.prepare("UPDATE outbox SET status = 'CANCELLED' WHERE kind != 'PROMPT'").run();
    await tick();
    expect((await rows("member_id = 2 AND kind = 'PROMPT'"))[0]).toMatchObject({ status: "RETRY_WAIT", last_error: "not_linked", attempts: 0 });
    clock.set(at(D, "12:00"));
    await tick();
    expect((await rows("member_id = 2 AND kind = 'PROMPT'"))[0].status).toBe("FAILED");
  });

  it("a cancelled duty cancels its queued messages; a missed duty is marked MISSED at its end", async () => {
    clock.set(at(D, "06:00"));
    await publishRows([{ date: D, staffCode: "S002", locationCode: "GATE", shift: "PM" }]); // S001 AM removed
    await tick();
    expect((await prompt()).status).toBe("CANCELLED");
    clock.set(at(D, "18:00"));
    await tick({ line: undefined });
    expect((await db.prepare("SELECT status FROM duties WHERE shift = 'PM'").first())!.status).toBe("MISSED");
  });
});

describe("quiet hours", () => {
  it("a roster published late at night waits until 06:00; nothing goes out at 22:00", async () => {
    await reset(); applySchedule({ messageLanguage: "en" }); await seedMembers(1); await seedLocation();
    line = new FakeLineClient(); clock = new FixedClock(at(D, "22:00", -1));
    await publishRows([{ date: D, staffCode: "S001", locationCode: "GATE", shift: "AM" }], clock);
    await tick();
    expect(line.calls.length).toBe(0);
    const r = (await rows("kind = 'REMINDER'"))[0];
    expect(r).toMatchObject({ status: "QUEUED", next_attempt_at: at(D, "06:00") });
    clock.set(at(D, "06:00")); await tick();
    expect(texts().join()).toMatch(/Duty reminder/);
  });
});
