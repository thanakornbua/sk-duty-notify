import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handleRequest } from "../src/app";
import { FixedClock } from "../src/clock";
import { FakeLineClient } from "../src/line-fake";
import { at, D, db, reset } from "./helpers";

const SECRET = "test-channel-secret";
let line: FakeLineClient;
const clock = new FixedClock(at(D, "09:00"));

async function sign(body: string, secret = SECRET) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))));
}
async function post(body: string, signature?: string, secret: string | undefined = SECRET) {
  const req = new Request("https://x.test/webhook/line", { method: "POST", body, headers: signature ? { "x-line-signature": signature } : {} });
  return handleRequest(req, { ...env, LINE_CHANNEL_SECRET: secret, LIFF_ID: "test-liff" }, clock, line);
}
const follow = (id: string) => JSON.stringify({ events: [{ type: "follow", webhookEventId: id, replyToken: `r-${id}`, source: { type: "user", userId: "U001" } }] });

describe("webhook", () => {
  beforeEach(async () => { await reset(); line = new FakeLineClient(); });

  it("rejects missing or wrong signatures before parsing; fails closed without a secret", async () => {
    const body = follow("e1");
    expect((await post(body)).status).toBe(401);
    expect((await post(body, await sign(body, "other"))).status).toBe(401);
    expect((await post(body, await sign(body + " "))).status).toBe(401);
    expect((await post("not json", await sign("not json"))).status).toBe(400);
    expect((await post(body, await sign(body), "")).status).toBe(500); // no secret configured
  });

  it("follow: replies with the LIFF link page; redelivery is deduped", async () => {
    const body = follow("e1");
    expect((await post(body, await sign(body))).status).toBe(200);
    expect((await post(body, await sign(body))).status).toBe(200);
    expect(line.replies.length).toBe(1);
    expect(line.replies[0].messages[0].text).toContain("https://liff.line.me/test-liff/link");
  });

  it("a shared location message is never a check-in (just help text)", async () => {
    const body = JSON.stringify({ events: [{ type: "message", webhookEventId: "e2", replyToken: "r", source: { type: "user", userId: "U001" },
      message: { type: "location", latitude: 13.75, longitude: 100.5 } }] });
    await post(body, await sign(body));
    expect(line.replies[0].messages[0].text).toMatch(/แชตนี้ใช้ส่งการแจ้งเตือนเวรเท่านั้น/);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM checkins").first<{ n: number }>())!.n).toBe(0);
  });

  it("a failed reply is recorded on the event, not swallowed", async () => {
    line.replyFails = true;
    const body = follow("e9");
    expect((await post(body, await sign(body))).status).toBe(200);
    expect((await db.prepare("SELECT outcome FROM webhook_events WHERE webhook_event_id = 'e9'").first())!.outcome).toBe("reply_failed");
  });

  it("group events are recorded and ignored", async () => {
    const body = JSON.stringify({ events: [{ type: "message", webhookEventId: "e3", replyToken: "r", source: { type: "group", groupId: "G" }, message: { type: "text" } }] });
    await post(body, await sign(body));
    expect(line.replies.length).toBe(0);
    expect((await db.prepare("SELECT outcome FROM webhook_events").first())!.outcome).toBe("ignored");
  });
});
