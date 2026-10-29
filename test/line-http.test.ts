import { describe, expect, it } from "vitest";
import { HttpLineClient } from "../src/line-http";

const client = (status: number, headers: Record<string, string> = {}, body = "{}") =>
  new HttpLineClient("tok", "1234", (async () => new Response(body, { status, headers })) as typeof fetch);
const push = (c: HttpLineClient) => c.push({ to: "U1", messages: [{ type: "text", text: "x" }], retryKey: "k" });

describe("HttpLineClient status mapping", () => {
  it("maps push responses", async () => {
    expect(await push(client(200, { "x-line-request-id": "r1" }))).toEqual({ kind: "accepted", requestId: "r1" });
    expect(await push(client(409, { "x-line-accepted-request-id": "r0" }))).toEqual({ kind: "duplicate", acceptedRequestId: "r0" });
    expect(await push(client(429, { "retry-after": "30" }))).toEqual({ kind: "rate_limited", retryAfterSeconds: 30 });
    expect(await push(client(502))).toEqual({ kind: "server_error", status: 502 });
    expect(await push(client(400, {}, "bad"))).toEqual({ kind: "client_error", status: 400, message: "bad" });
    const down = new HttpLineClient("t", "1", (async () => { throw new Error("net"); }) as typeof fetch);
    expect(await push(down)).toEqual({ kind: "timeout" });
  });

  it("sends the retry key header", async () => {
    let seen: Headers | undefined;
    const c = new HttpLineClient("t", "1", (async (_u: string, init: RequestInit) => { seen = new Headers(init.headers); return new Response("{}"); }) as any);
    await push(c);
    expect(seen!.get("x-line-retry-key")).toBe("k");
  });

  it("ID token verify: sub only when aud matches the LIFF channel", async () => {
    expect(await client(200, {}, JSON.stringify({ sub: "U1", aud: "1234" })).verifyIdToken("t")).toEqual({ ok: true, userId: "U1" });
    expect((await client(200, {}, JSON.stringify({ sub: "U1", aud: "999" })).verifyIdToken("t")).ok).toBe(false);
    expect((await client(400).verifyIdToken("t")).ok).toBe(false);
    await expect(client(503).verifyIdToken("t")).rejects.toThrow();
  });
});
