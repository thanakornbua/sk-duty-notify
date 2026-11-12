import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock";
import { googleHttp } from "../src/google";
import { FakeLineClient } from "../src/line-fake";
import { at, call, D, db, dutyId, MIN, SITE, standardDay } from "./helpers";

let line: FakeLineClient, clock: FixedClock;
const CLIENT = "test-client.apps.googleusercontent.com";
const realFetch = googleHttp.fetch;
const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function googleReturns(claims: Record<string, unknown>) {
  googleHttp.fetch = async () => {
    const c = { iss: "https://accounts.google.com", aud: CLIENT, exp: Math.floor(clock.now() / 1000) + 3600, email_verified: true, ...claims };
    return new Response(JSON.stringify({ id_token: `${b64url({ alg: "RS256" })}.${b64url(c)}.sig` }), { headers: { "content-type": "application/json" } });
  };
}
const cookieOf = (res: Response, name: string) =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(";")[0].slice(name.length + 1) ?? "";

/** Full portal sign-in; returns the member session cookie value. */
async function signIn(email: string, hd = "school.test") {
  const start = await call(line, clock, "GET", "/auth/google/member");
  expect(start.status).toBe(303);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const sc = cookieOf(start, "__Host-sdn_oauth_me");
  googleReturns({ email, hd });
  const cb = await call(line, clock, "GET", `/auth/google/callback?state=${encodeURIComponent(state)}&code=c`, undefined, { cookie: `__Host-sdn_oauth_me=${sc}` });
  return { cb, session: cookieOf(cb, "__Host-sdn_member") };
}
const me = (session: string, method: string, path: string, body?: unknown) =>
  call(line, clock, method, path, body, { cookie: `__Host-sdn_member=${session}`, origin: "https://x.test" });

beforeEach(async () => {
  await standardDay({ unlinked: [2] });
  await db.batch([1, 2].map((i) => db.prepare("UPDATE members SET email = ? WHERE id = ?").bind(`person${i}@school.test`, i)));
  line = new FakeLineClient();
  clock = new FixedClock(at(D, "06:40"));
});
afterEach(() => { googleHttp.fetch = realFetch; });

describe("member portal", () => {
  it("Google sign-in with the roster email opens a session; records show own duties only, no coordinates", async () => {
    const { cb, session } = await signIn("Person1@school.test");
    expect(cb.status).toBe(303);
    expect(cb.headers.get("location")).toBe("/me");
    expect(cb.headers.getSetCookie().join(";")).toContain("SameSite=Lax");
    expect(session.length).toBeGreaterThan(20);
    const who = (await (await me(session, "GET", "/me/api/me")).json()) as any;
    expect(who.member).toMatchObject({ staffCode: "S001", label: "Person 1", email: "person1@school.test", linked: true });
    const rec = (await (await me(session, "GET", "/me/api/records")).json()) as any;
    expect(rec.duties.map((d: any) => d.shift).sort()).toEqual(["AM", "PM"]);
    expect(rec.totals).toMatchObject({ total: 2, pending: 2, checkedIn: 0 });
    expect(JSON.stringify(rec)).not.toMatch(/"lat"|"lng"/);
  });

  it("refuses emails not on the roster, other domains, and a missing state cookie", async () => {
    expect((await signIn("nobody@school.test")).cb.headers.get("location")).toBe("/me?error=not_on_roster");
    expect((await signIn("person1@other.test", "other.test")).cb.headers.get("location")).toBe("/me?error=domain_not_allowed");
    const start = await call(line, clock, "GET", "/auth/google/member");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const cb = await call(line, clock, "GET", `/auth/google/callback?state=${state}&code=c`);
    expect(cb.headers.get("location")).toBe("/me?error=bad_state");
  });

  it("unauthenticated and cross-origin requests are refused; logout ends the session", async () => {
    expect((await call(line, clock, "GET", "/me/api/me")).status).toBe(401);
    const { session } = await signIn("person1@school.test");
    expect((await call(line, clock, "POST", "/me/api/checkin/start", {}, { cookie: `__Host-sdn_member=${session}`, origin: "https://evil.test" })).status).toBe(403);
    expect((await me(session, "POST", "/me/api/logout")).status).toBe(200);
    expect((await me(session, "GET", "/me/api/me")).status).toBe(401);
  });

  it("idle sessions expire", async () => {
    const { session } = await signIn("person1@school.test");
    clock.set(clock.now() + 15 * 1440 * MIN);
    expect((await me(session, "GET", "/me/api/me")).status).toBe(401);
  });

  it("web check-in for an unlinked member: same checks, attempt recorded as via web", async () => {
    const { session } = await signIn("person2@school.test");
    const s = (await (await me(session, "POST", "/me/api/checkin/start")).json()) as any;
    expect(s.current.dutyId).toBe(await dutyId(2));
    const far = await me(session, "POST", "/me/api/checkin/submit", { dutyId: s.current.dutyId, nonce: s.current.nonce, lat: SITE.lat + 0.01, lng: SITE.lng, accuracy: 10 });
    expect(((await far.json()) as any).result).toBe("outside_geofence");
    const s2 = (await (await me(session, "POST", "/me/api/checkin/start")).json()) as any;
    const ok = (await (await me(session, "POST", "/me/api/checkin/submit", { dutyId: s2.current.dutyId, nonce: s2.current.nonce, ...SITE, accuracy: 10 })).json()) as any;
    expect(ok.result).toBe("ok");
    const a = await db.prepare("SELECT via FROM checkins WHERE member_id = 2 ORDER BY id").all<{ via: string }>();
    expect(a.results.map((r) => r.via)).toEqual(["web", "web"]);
    // The receipt is an email row, whatever the LINE link.
    expect((await db.prepare("SELECT channel, dedupe_key FROM outbox WHERE kind = 'CONFIRM'").all()).results)
      .toEqual([{ channel: "email", dedupe_key: `EC:${s2.current.dutyId}` }]);
    // Cannot submit someone else's duty.
    const s3 = (await (await me(session, "POST", "/me/api/checkin/start")).json()) as any;
    const other = (await (await me(session, "POST", "/me/api/checkin/submit", { dutyId: await dutyId(1), nonce: s3.current?.nonce ?? "x", ...SITE, accuracy: 10 })).json()) as any;
    expect(other.reason).toBe("not_your_duty");
  });

  it("linking LINE from the LIFF flow also signs the member in to the portal", async () => {
    const res = await call(line, clock, "POST", "/api/google/link-start", { idToken: "tok:U002" });
    const state = new URL(((await res.json()) as any).url).searchParams.get("state")!;
    googleReturns({ email: "person2@school.test", hd: "school.test" });
    const cb = await call(line, clock, "GET", `/auth/google/callback?state=${state}&code=c`);
    expect(cb.headers.get("location")).toContain("r=ok");
    const session = cookieOf(cb, "__Host-sdn_member");
    expect(((await (await me(session, "GET", "/me/api/me")).json()) as any).member.linked).toBe(true);
  });
});
