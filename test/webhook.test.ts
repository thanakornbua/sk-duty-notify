import { env } from "cloudflare:workers";
import { describe, it, expect, beforeEach } from "vitest";
import { handleRequest } from "../src/app";
import { FixedClock } from "../src/clock";
import { config } from "../src/config";
import { FakeLineClient } from "../src/line-fake";
import { runScheduler } from "../src/scheduler";
import { D, MIN, TABLES, at, db, seed } from "./helpers";

const SECRET = "test-channel-secret";
const E = { ...env, LINE_CHANNEL_SECRET: SECRET };

let clock: FixedClock;
let line: FakeLineClient;
let n = 0;

beforeEach(async () => {
  for (const t of TABLES) await db.prepare(`DELETE FROM ${t}`).run();
  clock = new FixedClock(at(D, "05:00"));
  line = new FakeLineClient();
  n = 0;
});

async function sign(body: string, secret = SECRET) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return btoa(String.fromCharCode(...mac));
}

async function post(events: unknown[], opts: { env?: any; signature?: string; body?: string } = {}) {
  const body = opts.body ?? JSON.stringify({ destination: "Udest", events });
  const signature = opts.signature ?? (await sign(body));
  return handleRequest(new Request("https://x.test/webhook/line", {
    method: "POST", headers: { "x-line-signature": signature, "content-type": "application/json" }, body,
  }), opts.env ?? E, clock, line);
}

const postback = (userId: string, data: string, over: Record<string, unknown> = {}) => ({
  type: "postback", webhookEventId: `E${++n}`, replyToken: `T${n}`, timestamp: clock.now(),
  source: { type: "user", userId }, postback: { data }, ...over,
});
const text = (userId: string, t: string, over: Record<string, unknown> = {}) => ({
  type: "message", webhookEventId: `E${++n}`, replyToken: `T${n}`, source: { type: "user", userId },
  message: { type: "text", text: t }, ...over,
});

/** Plan jobs (creates action_states) at the current clock without sending anything. */
const plan = () => runScheduler({ db, clock });
const action = async (staff: string, kind: string) =>
  (await db.prepare(
    `SELECT s.* FROM action_states s JOIN assignments a ON a.id = s.assignment_id WHERE a.staff_id = ? AND s.action_kind = ?`,
  ).bind(staff, kind).first<any>())!;
const data = (a: any) => `a=${a.id}&r=${a.revision}`;
const count = async (t: string) => (await db.prepare(`SELECT COUNT(*) n FROM ${t}`).first<{ n: number }>())!.n;
const lastReply = () => (line.replies.at(-1)!.messages[0] as any).text as string;

async function adminCode(staffId: string, token = "test-token") {
  const r = await handleRequest(new Request("https://x.test/admin/binding-codes", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ staffId }),
  }), E, clock, line);
  return { status: r.status, body: await r.json() as any };
}

describe("signature", () => {
  beforeEach(async () => { await seed([D]); clock.set(at(D, "06:30")); await plan(); });

  it("rejects a bad, missing, or wrong-secret signature before parsing, and changes nothing", async () => {
    const a = await action("S001", "AM");
    const ev = [postback("U001", data(a))];
    expect((await post(ev, { signature: "AAAA" })).status).toBe(401);
    expect((await post(ev, { signature: await sign("x", "wrong-secret") })).status).toBe(401);
    expect((await post(ev, { signature: "not base64 !!" })).status).toBe(401);
    const noSig = await handleRequest(new Request("https://x.test/webhook/line", { method: "POST", body: "{}" }), E, clock, line);
    expect(noSig.status).toBe(401);
    expect((await action("S001", "AM")).state).toBe("PENDING");
    expect(await count("webhook_events")).toBe(0);
  });

  it("verifies the RAW body: a re-serialised (equivalent) JSON body fails", async () => {
    const a = await action("S001", "AM");
    const body = JSON.stringify({ destination: "Udest", events: [postback("U001", data(a))] });
    const sig = await sign(body);
    expect((await post([], { body: body.replace('{"destination"', '{ "destination"'), signature: sig })).status).toBe(401);
    expect((await post([], { body, signature: sig })).status).toBe(200);
  });

  it("does not parse invalid JSON before the signature check (401, not 400), then 400 when signed", async () => {
    expect((await post([], { body: "{not json", signature: "AAAA" })).status).toBe(401);
    expect((await post([], { body: "{not json" })).status).toBe(400);
  });

  it("accepts LINE's verify call (empty events)", async () => {
    expect((await post([])).status).toBe(200);
  });

  it("fails closed when no channel secret is configured", async () => {
    expect((await post([], { env: { ...env, LINE_CHANNEL_SECRET: undefined } })).status).toBe(500);
  });
});

describe("postback", () => {
  beforeEach(async () => { await seed([D]); clock.set(at(D, "06:30")); await plan(); });

  it("completes on time, replies after the commit, and leaves the other actions alone", async () => {
    const am = await action("S001", "AM");
    let stateAtReply = "";
    line.onReply = async () => { stateAtReply = (await action("S001", "AM")).state; };
    clock.set(at(D, "06:45"));
    expect((await post([postback("U001", data(am))])).status).toBe(200);
    const done = await action("S001", "AM");
    expect(done).toMatchObject({ state: "COMPLETED", outcome: "on_time", completed_at: at(D, "06:45") });
    expect(stateAtReply).toBe("COMPLETED"); // committed before the reply was sent
    expect(lastReply()).toContain("recorded");
    expect((await action("S001", "PM")).state).toBe("PENDING");
    expect((await action("S001", "ACK")).state).toBe("EXPIRED"); // ACK cutoff 06:30 had passed at planning; untouched
    expect((await action("S002", "AM")).state).toBe("PENDING");
  });

  it("late press: after start+30 min is recorded late but accepted; exactly +30:00 is on time", async () => {
    const am1 = await action("S001", "AM"), am2 = await action("S002", "AM"), am3 = await action("S003", "AM");
    clock.set(at(D, "07:00"));
    await post([postback("U001", data(am1))]);
    expect((await action("S001", "AM")).outcome).toBe("on_time");
    clock.set(at(D, "07:00") + 1);
    await post([postback("U002", data(am2))]);
    expect((await action("S002", "AM")).outcome).toBe("late");
    expect(lastReply()).toContain("late");
    clock.set(at(D, "11:59"));
    await post([postback("U003", data(am3))]);
    expect((await action("S003", "AM")).outcome).toBe("late");
  });

  it("after the cutoff the press is refused and the action becomes EXPIRED", async () => {
    const am = await action("S001", "AM");
    clock.set(at(D, "12:00"));
    await post([postback("U001", data(am))]);
    expect((await action("S001", "AM")).state).toBe("EXPIRED");
    expect(lastReply()).toContain("closed");
  });

  it("before the window opens: refused, still PENDING, can be pressed later", async () => {
    const pm = await action("S001", "PM");
    clock.set(at(D, "14:19"));
    await post([postback("U001", data(pm))]);
    expect((await action("S001", "PM")).state).toBe("PENDING");
    expect(lastReply()).toContain("not open");
    clock.set(at(D, "14:20"));
    await post([postback("U001", data(pm))]);
    expect((await action("S001", "PM")).state).toBe("COMPLETED");
  });

  it("duplicate delivery of the same webhookEventId is processed once and gets no second reply", async () => {
    const am = await action("S001", "AM");
    const ev = postback("U001", data(am));
    await post([ev]);
    const first = await action("S001", "AM");
    clock.advance(5 * MIN);
    expect((await post([ev])).status).toBe(200);
    expect(await action("S001", "AM")).toEqual(first);
    expect(line.replies).toHaveLength(1);
    expect(await count("webhook_events")).toBe(1);
  });

  it("double tap (a new event id) is idempotent and reports the existing status", async () => {
    const am = await action("S001", "AM");
    clock.set(at(D, "06:40"));
    await post([postback("U001", data(am))]);
    const first = await action("S001", "AM");
    clock.set(at(D, "08:00"));
    await post([postback("U001", data(am))]);
    expect(await action("S001", "AM")).toEqual(first); // completed_at unchanged
    expect(lastReply()).toContain("already");
    expect(await count("webhook_events")).toBe(2);
    const audits = await db.prepare("SELECT COUNT(*) n FROM audit_log WHERE event='action_completed'").first<any>();
    expect(audits.n).toBe(1);
  });

  it("two taps in one delivery: exactly one completes", async () => {
    const am = await action("S001", "AM");
    await post([postback("U001", data(am)), postback("U001", data(am))]);
    expect((await action("S001", "AM")).state).toBe("COMPLETED");
    expect(line.replies.map((r) => (r.messages[0] as any).text)).toEqual([
      expect.stringContaining("recorded"), expect.stringContaining("already"),
    ]);
  });

  it("a forwarded button pressed by someone else, or by an unbound user, does not complete it", async () => {
    const am = await action("S001", "AM");
    await post([postback("U002", data(am))]); // another staff member
    expect((await action("S001", "AM")).state).toBe("PENDING");
    expect(lastReply()).toContain("someone else");
    await post([postback("Ustranger", data(am))]); // not bound to anyone
    expect((await action("S001", "AM")).state).toBe("PENDING");
    expect((await action("S002", "AM")).state).toBe("PENDING");
    const outcomes = (await db.prepare("SELECT outcome FROM webhook_events").all<any>()).results.map((r: any) => r.outcome);
    expect(outcomes).toEqual(["not_owner", "not_owner"]);
  });

  it("an event from a group chat is ignored even with a valid button", async () => {
    const am = await action("S001", "AM");
    await post([postback("U001", data(am), { source: { type: "group", groupId: "G1", userId: "U001" } })]);
    expect((await action("S001", "AM")).state).toBe("PENDING");
    expect(line.replies).toHaveLength(0);
  });

  it("rejects malformed, unknown, and stale-revision buttons", async () => {
    const am = await action("S001", "AM");
    await post([postback("U001", "a=abc&r=1")]);
    await post([postback("U001", "a=999999&r=1")]);
    await post([postback("U001", `a=${am.id}&r=2`)]);
    await post([postback("U001", `a=${am.id}&r=1&evil=1`)]);
    expect((await action("S001", "AM")).state).toBe("PENDING");
    expect(line.replies).toHaveLength(4);
  });

  it("a withdrawn assignment cannot be completed", async () => {
    const am = await action("S001", "AM");
    await db.prepare("UPDATE assignments SET withdrawn = 1 WHERE staff_id = 'S001'").run();
    await post([postback("U001", data(am))]);
    expect((await action("S001", "AM")).state).toBe("PENDING");
  });

  it("ACK is independent of AM and PM", async () => {
    clock.set(at(D, "16:00", -1));
    await db.prepare("DELETE FROM action_states").run();
    await db.prepare("DELETE FROM notification_jobs").run();
    await plan();
    const ack = await action("S001", "ACK");
    await post([postback("U001", data(ack))]);
    expect((await action("S001", "ACK")).state).toBe("COMPLETED");
    expect((await action("S001", "AM")).state).toBe("PENDING");
    expect((await action("S001", "PM")).state).toBe("PENDING");
  });

  it("DB failure returns 5xx and leaves no trace; the redelivery then succeeds", async () => {
    const am = await action("S001", "AM");
    const ev = postback("U001", data(am));
    const broken = { ...env, LINE_CHANNEL_SECRET: SECRET, DB: { prepare: (q: string) => env.DB.prepare(q), batch: () => Promise.reject(new Error("db down")) } };
    expect((await post([ev], { env: broken })).status).toBe(500);
    expect((await action("S001", "AM")).state).toBe("PENDING");
    expect(await count("webhook_events")).toBe(0);
    expect(line.replies).toHaveLength(0);
    expect((await post([ev])).status).toBe(200); // LINE redelivers the same event id
    expect((await action("S001", "AM")).state).toBe("COMPLETED");
  });

  it("a completed action suppresses its reminder (end to end with the scheduler)", async () => {
    clock.set(at(D, "06:30"));
    await runScheduler({ db, clock, line, rand: () => 0.5 });
    expect(line.sent).toHaveLength(10);
    const am = await action("S001", "AM");
    clock.set(at(D, "06:40"));
    await post([postback("U001", data(am))]);
    clock.set(at(D, "07:00"));
    await runScheduler({ db, clock, line, rand: () => 0.5 });
    expect(line.sent).toHaveLength(19); // 9 reminders; none for S001
    expect(line.sent.filter((s) => s.to === "U001")).toHaveLength(1);
  });

  it("the postback carried by a real push matches the action", async () => {
    clock.set(at(D, "06:30"));
    await runScheduler({ db, clock, line, rand: () => 0.5 });
    const push = line.sent.find((s) => s.to === "U001")!;
    const pb = (push.messages[0] as any).template.actions[0].data as string;
    await post([postback("U001", pb)]);
    expect((await action("S001", "AM")).state).toBe("COMPLETED");
  });
});

describe("binding", () => {
  beforeEach(async () => { await seed([D], [], { unbound: [1, 2] }); });

  it("admin issues a one-time code (admin token required); typing it binds the webhook userId", async () => {
    expect((await adminCode("S001", "wrong")).status).toBe(401);
    expect((await adminCode("NOPE")).status).toBe(404);
    const { body } = await adminCode("S001");
    expect(body.code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
    expect(body.expiresAt).toBe(clock.now() + config.bindingCodeTtlMinutes * MIN);
    await post([text("Unew1", ` ${body.code.toLowerCase()} `)]); // case/space tolerant
    const p = await db.prepare("SELECT line_user_id, bound_at FROM people WHERE staff_id='S001'").first<any>();
    expect(p).toEqual({ line_user_id: "Unew1", bound_at: clock.now() });
    expect(lastReply()).toContain("S001");
  });

  it("a code works once", async () => {
    const { body } = await adminCode("S001");
    await post([text("Unew1", body.code)]);
    await post([text("Unew2", body.code)]);
    expect((await db.prepare("SELECT line_user_id FROM people WHERE staff_id='S001'").first<any>()).line_user_id).toBe("Unew1");
    expect(lastReply()).toContain("not valid");
  });

  it("an expired code, a revoked (superseded) code, and a wrong code all fail the same way", async () => {
    const old = (await adminCode("S001")).body.code;
    const fresh = (await adminCode("S001")).body.code; // revokes `old`
    await post([text("Unew1", old)]);
    expect((await db.prepare("SELECT line_user_id FROM people WHERE staff_id='S001'").first<any>()).line_user_id).toBeNull();
    await post([text("Unew1", "ZZZZZZZZ")]);
    clock.advance((config.bindingCodeTtlMinutes + 1) * MIN);
    await post([text("Unew1", fresh)]);
    expect((await db.prepare("SELECT line_user_id FROM people WHERE staff_id='S001'").first<any>()).line_user_id).toBeNull();
    expect(line.replies.map((r) => (r.messages[0] as any).text)).toEqual(Array(3).fill(config.messages.replies.bindFailed));
  });

  it("never binds by display name or free text; non-code text gets help", async () => {
    await post([text("Unew1", "Person 1")]);
    await post([text("Unew1", "S001")]);
    expect((await db.prepare("SELECT COUNT(*) n FROM people WHERE line_user_id IS NOT NULL AND staff_id IN ('S001','S002')").first<any>()).n).toBe(0);
    expect(lastReply()).toBe(config.messages.replies.help);
  });

  it("a code typed in a group chat does nothing", async () => {
    const { body } = await adminCode("S001");
    await post([text("Unew1", body.code, { source: { type: "group", groupId: "G", userId: "Unew1" } })]);
    expect((await db.prepare("SELECT line_user_id FROM people WHERE staff_id='S001'").first<any>()).line_user_id).toBeNull();
  });

  it("one LINE user cannot hold two staff IDs; the second code is not consumed-and-lost silently", async () => {
    const a = (await adminCode("S001")).body.code, b = (await adminCode("S002")).body.code;
    await post([text("Unew1", a)]);
    await post([text("Unew1", b)]);
    expect(lastReply()).toBe(config.messages.replies.alreadyBound);
    expect((await db.prepare("SELECT line_user_id FROM people WHERE staff_id='S002'").first<any>()).line_user_id).toBeNull();
    expect((await db.prepare("SELECT used_at FROM binding_codes WHERE code = ?").bind(b).first<any>()).used_at).toBeNull();
  });

  it("re-binding a staff ID to a new account replaces the old one: the old account loses access", async () => {
    clock.set(at(D, "06:30"));
    await plan();
    const first = (await adminCode("S001")).body.code;
    await post([text("Uold", first)]);
    const second = (await adminCode("S001")).body.code;
    await post([text("Unew", second)]);
    const am = await action("S001", "AM");
    await post([postback("Uold", data(am))]);
    expect((await action("S001", "AM")).state).toBe("PENDING");
    await post([postback("Unew", data(am))]);
    expect((await action("S001", "AM")).state).toBe("COMPLETED");
  });

  it("an unbound user's button press is refused", async () => {
    clock.set(at(D, "06:30"));
    await plan();
    const am = await action("S001", "AM"); // S001 is unbound in this setup
    await post([postback("Usomeone", data(am))]);
    expect((await action("S001", "AM")).state).toBe("PENDING");
  });

  it("a freshly bound user starts receiving pushes", async () => {
    const { body } = await adminCode("S001");
    await post([text("Unew1", body.code)]);
    clock.set(at(D, "06:30"));
    await runScheduler({ db, clock, line, rand: () => 0.5 });
    expect(line.sent.some((s) => s.to === "Unew1")).toBe(true);
  });
});
