import { beforeEach, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth";
import { FixedClock } from "../src/clock";
import { config } from "../src/config";
import { FakeLineClient } from "../src/line-fake";
import { ADMIN, at, call, D, db, MIN, reset } from "./helpers";

let line: FakeLineClient, clock: FixedClock;
const ORIGIN = { origin: "https://x.test" };
const cookieOf = (res: Response) => /__Host-sdn_session=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
const signIn = (username = ADMIN.username, password = ADMIN.password, headers: Record<string, string> = ORIGIN) =>
  call(line, clock, "POST", "/admin/api/login", { username, password }, headers);
const as = (token: string | undefined, method: string, path: string, body?: unknown) =>
  call(line, clock, method, path, body, { cookie: `__Host-sdn_session=${token}`, ...ORIGIN });

beforeEach(async () => {
  await reset();
  await db.prepare("DELETE FROM admin_sessions").run();
  line = new FakeLineClient();
  clock = new FixedClock(at(D, "09:00"));
});

describe("password hashing", () => {
  it("PBKDF2 round trip; each hash records its iteration count and salt", async () => {
    const h = await hashPassword("a long enough password", 1000);
    expect(h).toMatch(/^pbkdf2-sha256\$1000\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}$/);
    expect(await verifyPassword("a long enough password", h)).toBe(true);
    expect(await verifyPassword("a long enough passworD", h)).toBe(false);
    expect(await hashPassword("x", 1000)).not.toBe(await hashPassword("x", 1000));
    expect(await verifyPassword("x", "md5$1$abc$def")).toBe(false);
  });

  it("a hash made by Node's crypto (as scripts/create-admin.mjs does) verifies with the server code", async () => {
    // Fixture: node pbkdf2Sync("temporary-pass-1", "0123456789abcdef", 20000, 32, "sha256").
    const h = "pbkdf2-sha256$20000$MDEyMzQ1Njc4OWFiY2RlZg==$1oi0HDD6V/nnLzOFxYV50g51JqXcxJNJiIkOR0QnpO4=";
    expect(await verifyPassword("temporary-pass-1", h)).toBe(true);
    expect(await verifyPassword("temporary-pass-2", h)).toBe(false);
  });
});

describe("admin login", () => {
  it("signs in with an HttpOnly, Secure, SameSite=Strict __Host- cookie; the token is stored hashed", async () => {
    const res = await signIn();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: { username: ADMIN.username, displayName: "Ops Admin", mustChange: false } });
    const sc = res.headers.get("set-cookie")!;
    expect(sc).toMatch(/^__Host-sdn_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200$/);
    const token = cookieOf(res)!;
    expect(await db.prepare("SELECT 1 FROM admin_sessions WHERE token_hash = ?").bind(token).first()).toBeNull();
    expect((await as(token, "GET", "/admin/api/me")).status).toBe(200);
    expect((await as(token, "GET", "/admin/api/today")).status).toBe(200);
  });

  it("username is case-insensitive", async () => {
    expect((await signIn(ADMIN.username.toUpperCase())).status).toBe(200);
  });

  it("wrong password and unknown user get the same answer", async () => {
    const a = await signIn(ADMIN.username, "wrong-password-xx");
    const b = await signIn("nobody", "wrong-password-xx");
    expect([a.status, b.status]).toEqual([401, 401]);
    expect(await a.json()).toEqual(await b.json());
  });

  it("locks after 5 failures for 15 minutes, even with the right password", async () => {
    for (let i = 0; i < config.auth.maxFailedLogins; i++) await signIn(ADMIN.username, "wrong-password-xx");
    const locked = await signIn();
    expect(locked.status).toBe(429);
    expect((await locked.json() as any).error).toBe("locked");
    clock.advance(config.auth.lockoutMinutes * MIN);
    expect((await signIn()).status).toBe(200);
  });

  it("a disabled account cannot sign in, and its sessions stop working", async () => {
    const token = cookieOf(await signIn())!;
    await db.prepare("UPDATE admin_users SET disabled = 1").run();
    expect((await as(token, "GET", "/admin/api/me")).status).toBe(401);
    expect((await signIn()).status).toBe(401);
  });

  it("cross-origin or Origin-less state changes are refused (CSRF), including login", async () => {
    expect((await signIn(ADMIN.username, ADMIN.password, {})).status).toBe(403);
    const token = cookieOf(await signIn())!;
    const evil = await call(line, clock, "POST", "/admin/api/logout", {}, { cookie: `__Host-sdn_session=${token}`, origin: "https://evil.test" });
    expect(evil.status).toBe(403);
  });

  it("sessions end at logout, after 2 h idle, and after 12 h absolute", async () => {
    let token = cookieOf(await signIn())!;
    const out = await as(token, "POST", "/admin/api/logout");
    expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    expect((await as(token, "GET", "/admin/api/me")).status).toBe(401);

    token = cookieOf(await signIn())!;
    clock.advance(config.auth.idleMinutes * MIN);
    expect((await as(token, "GET", "/admin/api/me")).status).toBe(401);

    token = cookieOf(await signIn())!;
    for (let h = 0; h < 12; h++) { clock.advance(60 * MIN); await as(token, "GET", "/admin/api/me"); } // stays active
    expect((await as(token, "GET", "/admin/api/me")).status).toBe(401);
  });

  it("a temporary password must be changed before anything else; other sessions are signed out", async () => {
    await db.prepare("UPDATE admin_users SET must_change = 1").run();
    const other = cookieOf(await signIn())!;
    const token = cookieOf(await signIn())!;
    expect((await as(token, "GET", "/admin/api/today")).status).toBe(403);
    expect((await (await as(token, "POST", "/admin/api/password", { current: ADMIN.password, next: "short" })).json() as any).error).toMatch(/at least 12/);
    expect((await as(token, "POST", "/admin/api/password", { current: ADMIN.password, next: "x-ops.admin-x-long" })).status).toBe(422);
    expect((await as(token, "POST", "/admin/api/password", { current: "wrong", next: "a brand new passphrase" })).status).toBe(422);
    expect((await as(token, "POST", "/admin/api/password", { current: ADMIN.password, next: "a brand new passphrase" })).status).toBe(200);
    expect((await as(token, "GET", "/admin/api/today")).status).toBe(200);
    expect((await as(other, "GET", "/admin/api/me")).status).toBe(401);
    expect((await signIn(ADMIN.username, "a brand new passphrase")).status).toBe(200);
  });

  it("the dev bearer token does not open the admin API", async () => {
    const res = await call(line, clock, "GET", "/admin/api/today", undefined, { authorization: "Bearer test-token" });
    expect(res.status).toBe(401);
  });
});
