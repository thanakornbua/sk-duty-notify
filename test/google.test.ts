import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleRequest } from "../src/app";
import { FixedClock } from "../src/clock";
import { googleHttp } from "../src/google";
import { FakeLineClient } from "../src/line-fake";
import { admin, ADMIN, at, call, D, db, MIN, reset, seedMembers, token } from "./helpers";

let line: FakeLineClient, clock: FixedClock;
const CLIENT = "test-client.apps.googleusercontent.com";
const realFetch = googleHttp.fetch;
let tokenRequests: URLSearchParams[] = [];

const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** Google's token endpoint answers with an ID token carrying these claims. */
function googleReturns(claims: Record<string, unknown>) {
  googleHttp.fetch = async (_url, init) => {
    tokenRequests.push(new URLSearchParams(String(init?.body)));
    const c = { iss: "https://accounts.google.com", aud: CLIENT, exp: Math.floor(clock.now() / 1000) + 3600, email_verified: true, ...claims };
    return new Response(JSON.stringify({ id_token: `${b64url({ alg: "RS256" })}.${b64url(c)}.sig` }), { headers: { "content-type": "application/json" } });
  };
}
const person = (n: number, extra: Record<string, unknown> = {}) => ({ email: `Person${n}@school.test`, hd: "school.test", ...extra });

async function linkStart(n: number) {
  const res = await call(line, clock, "POST", "/api/google/link-start", { idToken: token(n) });
  const body = (await res.json()) as { url?: string; error?: string };
  return { res, body, state: body.url ? new URL(body.url).searchParams.get("state")! : "" };
}
const back = (state: string, extra = "&code=auth-code", headers: Record<string, string> = {}) =>
  call(line, clock, "GET", `/auth/google/callback?state=${encodeURIComponent(state)}${extra}`, undefined, headers);
const landing = (res: Response) => new URL(res.headers.get("location")!, "https://x.test");

beforeEach(async () => {
  await reset();
  await seedMembers(3, { unlinked: [1, 2, 3] });
  await db.batch([1, 2, 3].map((i) => db.prepare("UPDATE members SET email = ? WHERE id = ?").bind(`person${i}@school.test`, i)));
  line = new FakeLineClient();
  clock = new FixedClock(at(D, "09:00"));
  tokenRequests = [];
});
afterEach(() => { googleHttp.fetch = realFetch; });

describe("member linking with Google", () => {
  it("links the LINE-verified user to the member with the Google email; PKCE; state single use", async () => {
    const { res, body, state } = await linkStart(1);
    expect(res.status).toBe(200);
    const auth = new URL(body.url!);
    expect(auth.origin + auth.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(auth.searchParams.get("redirect_uri")).toBe("https://x.test/auth/google/callback");
    expect(auth.searchParams.get("hd")).toBe("*");
    expect(await db.prepare("SELECT 1 FROM oauth_states WHERE state_hash = ?").bind(state).first()).toBeNull(); // hashed at rest

    googleReturns(person(1));
    const cb = await back(state);
    expect(cb.status).toBe(303);
    expect(Object.fromEntries(landing(cb).searchParams)).toEqual({ r: "ok", name: "Person 1" });
    expect((await db.prepare("SELECT line_user_id FROM members WHERE id = 1").first())!.line_user_id).toBe("U001");
    // PKCE: the verifier sent to Google hashes to the challenge in the authorization URL.
    const verifier = tokenRequests[0].get("code_verifier")!;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    expect(btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")).toBe(auth.searchParams.get("code_challenge"));

    expect(landing(await back(state)).searchParams.get("r")).toBe("bad_state"); // replay
    const status = (await (await call(line, clock, "POST", "/api/status", { idToken: token(1) })).json()) as any;
    expect(status).toEqual({ linked: true, label: "Person 1", staffCode: "S001" });
  });

  it("a forged LINE ID token cannot start linking", async () => {
    expect((await call(line, clock, "POST", "/api/google/link-start", { idToken: "forged" })).status).toBe(401);
  });

  it("refuses other domains, consumer accounts, unverified emails, wrong audience and unknown emails", async () => {
    for (const [claims, r] of [
      [{ email: "someone@gmail.com" }, "domain_not_allowed"],
      [{ email: "person1@school.test" }, "domain_not_allowed"], // no Workspace hd claim
      [person(1, { email_verified: false }), "email_not_verified"],
      [person(1, { aud: "someone-else" }), "google_failed"],
      [person(1, { exp: 1 }), "google_failed"],
      [{ email: "nobody@student.school.test", hd: "student.school.test" }, "not_on_roster"],
    ] as const) {
      const { state } = await linkStart(1);
      googleReturns(claims);
      expect([claims, landing(await back(state)).searchParams.get("r")]).toEqual([claims, r]);
    }
    expect((await db.prepare("SELECT line_user_id FROM members WHERE id = 1").first())!.line_user_id).toBeNull();
  });

  it("expired state, cancelled consent, and a LINE account linked to another member", async () => {
    let { state } = await linkStart(1);
    clock.advance(11 * MIN);
    googleReturns(person(1));
    expect(landing(await back(state)).searchParams.get("r")).toBe("bad_state");

    ({ state } = await linkStart(1));
    expect(landing(await back(state, "&error=access_denied")).searchParams.get("r")).toBe("cancelled");

    ({ state } = await linkStart(1));
    await back(state); // U001 -> member 1
    ({ state } = await linkStart(1));
    googleReturns(person(2)); // U001 signs in as member 2
    expect(landing(await back(state)).searchParams.get("r")).toBe("line_account_linked_elsewhere");
  });

  it("an inactive member cannot link", async () => {
    await db.prepare("UPDATE members SET active = 0 WHERE id = 3").run();
    const { state } = await linkStart(3);
    googleReturns(person(3));
    expect(landing(await back(state)).searchParams.get("r")).toBe("not_on_roster");
  });
});

describe("admin sign-in with Google", () => {
  const startAdmin = async (next = "/sheet") => {
    const res = await call(line, clock, "GET", `/auth/google/admin?next=${encodeURIComponent(next)}`);
    const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
    return { res, state, cookie: res.headers.get("set-cookie")!.split(";")[0] };
  };
  beforeEach(async () => {
    await db.prepare("UPDATE admin_users SET email = 'ops@school.test' WHERE id = 1").run();
  });

  it("signs in an admin by email and lands on `next`; the state is bound to the browser", async () => {
    const { res, state, cookie } = await startAdmin();
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toMatch(/^__Host-sdn_oauth=.+; Path=\/; HttpOnly; Secure; SameSite=Lax/);
    googleReturns({ email: "OPS@school.test", hd: "school.test" });
    const cb = await back(state, "&code=c", { cookie });
    expect(cb.status).toBe(200);
    expect(await cb.text()).toContain('url=/sheet"');
    const session = cb.headers.getSetCookie().find((c) => c.startsWith("__Host-sdn_session="))!.split(";")[0];
    const me = (await (await call(line, clock, "GET", "/admin/api/me", undefined, { cookie: session })).json()) as any;
    expect(me.user.username).toBe(ADMIN.username);
  });

  it("without the browser cookie (login CSRF) or for a non-admin / disabled admin, sign-in is refused", async () => {
    let { state, cookie } = await startAdmin();
    googleReturns({ email: "ops@school.test", hd: "school.test" });
    expect((await back(state, "&code=c")).headers.get("location")).toBe("/login?error=bad_state");
    expect(tokenRequests).toEqual([]); // refused before the code was exchanged

    ({ state, cookie } = await startAdmin());
    googleReturns({ email: "teacher@school.test", hd: "school.test" });
    expect((await back(state, "&code=c", { cookie })).headers.get("location")).toBe("/login?error=not_an_admin");

    await db.prepare("UPDATE admin_users SET disabled = 1 WHERE id = 1").run();
    ({ state, cookie } = await startAdmin());
    googleReturns({ email: "ops@school.test", hd: "school.test" });
    expect((await back(state, "&code=c", { cookie })).headers.get("location")).toBe("/login?error=not_an_admin");
  });

  it("an off-site `next` falls back to the dashboard", async () => {
    const { state, cookie } = await startAdmin("//evil.example/");
    googleReturns({ email: "ops@school.test", hd: "school.test" });
    expect(await (await back(state, "&code=c", { cookie })).text()).toContain('url=/dashboard"');
  });

  it("password login is off unless ALLOW_PASSWORD_LOGIN=1", async () => {
    const req = new Request("https://x.test/admin/api/login", {
      method: "POST", headers: { origin: "https://x.test", "content-type": "application/json" },
      body: JSON.stringify({ username: ADMIN.username, password: ADMIN.password }),
    });
    const res = await handleRequest(req, { ...env, ALLOW_PASSWORD_LOGIN: undefined }, clock, line);
    expect([res.status, ((await res.json()) as any).error]).toEqual([404, "password_login_disabled"]);
    const opts = (await (await admin(line, clock, "GET", "/admin/api/login-options")).json()) as any;
    expect(opts).toEqual({ google: true, password: true, domains: ["school.test", "student.school.test"] });
  });
});
