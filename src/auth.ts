import type { Clock } from "./clock";
import { config } from "./config";
import { MIN } from "./time";
import { sha256Hex } from "./util";

/**
 * Admin login: username + password (PBKDF2-SHA256), server-side sessions in an HttpOnly, Secure,
 * SameSite=Strict `__Host-` cookie. Only the SHA-256 of a session token is stored.
 */

const A = config.auth;
const enc = new TextEncoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

export async function hashPassword(password: string, iterations = A.pbkdf2Iterations): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(await derive(password, salt, iterations))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, it, salt, hash] = stored.split("$");
  const iterations = Number(it);
  if (alg !== "pbkdf2-sha256" || !Number.isInteger(iterations) || iterations < 1 || iterations > 100_000) return false;
  const want = unb64(hash), got = await derive(password, unb64(salt), iterations);
  return want.length === got.length && crypto.subtle.timingSafeEqual(want, got);
}

/** Verified against when the username is unknown, so both paths cost the same. */
const DUMMY = "pbkdf2-sha256$20000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/** Error codes (the UI translates them). */
export function passwordProblem(password: unknown, username: string): string | null {
  if (typeof password !== "string") return "password_required";
  if (password.length < A.minPasswordLength) return "password_too_short";
  if (password.length > 200) return "password_too_long";
  if (password.toLowerCase().includes(username.toLowerCase())) return "password_contains_username";
  return null;
}

export interface AdminUser { id: number; username: string; display_name: string; must_change: number }

const audit = (db: D1Database, at: number, actor: string, event: string, detail: unknown) =>
  db.prepare("INSERT INTO audit_log (at, actor, event, detail) VALUES (?, ?, ?, ?)").bind(at, actor, event, JSON.stringify(detail));

export type LoginResult =
  | { ok: true; token: string; user: AdminUser }
  /** Unknown user, wrong password and disabled account all look the same. */
  | { ok: false; error: "invalid_credentials" | "locked"; retryAt?: number };

export async function login(db: D1Database, clock: Clock, username: unknown, password: unknown, meta: { ipHash: string | null; userAgent: string | null }): Promise<LoginResult> {
  const now = clock.now();
  const name = typeof username === "string" ? username.trim().slice(0, 64) : "";
  const pw = typeof password === "string" ? password.slice(0, 200) : "";
  const user = name ? await db.prepare(
    "SELECT id, username, display_name, password_hash, must_change, failed_count, locked_until, disabled FROM admin_users WHERE username = ?",
  ).bind(name).first<AdminUser & { password_hash: string; failed_count: number; locked_until: number | null; disabled: number }>() : null;

  if (user?.locked_until && user.locked_until > now) {
    await audit(db, now, `admin:${user.username}`, "login_locked", { ipHash: meta.ipHash }).run();
    return { ok: false, error: "locked", retryAt: user.locked_until };
  }
  const good = await verifyPassword(pw, user?.password_hash ?? DUMMY);
  if (!user || !good || user.disabled) {
    if (user) {
      // Lock after maxFailedLogins consecutive failures; the counter restarts after the lockout.
      const lock = user.failed_count + 1 >= A.maxFailedLogins;
      await db.batch([
        db.prepare("UPDATE admin_users SET failed_count = ?, locked_until = ? WHERE id = ?")
          .bind(lock ? 0 : user.failed_count + 1, lock ? now + A.lockoutMinutes * MIN : user.locked_until, user.id),
        audit(db, now, `admin:${user.username}`, lock ? "login_failed_locked" : "login_failed", { ipHash: meta.ipHash }),
      ]);
    } else {
      await audit(db, now, "anonymous", "login_failed_unknown_user", { ipHash: meta.ipHash }).run();
    }
    return { ok: false, error: "invalid_credentials" };
  }

  await db.prepare("UPDATE admin_users SET failed_count = 0, locked_until = NULL WHERE id = ?").bind(user.id).run();
  const token = await createSession(db, clock, user, meta, "login");
  return { ok: true, token, user: { id: user.id, username: user.username, display_name: user.display_name, must_change: user.must_change } };
}

/** New session for a verified admin (password or Google). Returns the raw token for the cookie; only its hash is stored. */
export async function createSession(
  db: D1Database, clock: Clock, user: { id: number; username: string }, meta: { ipHash: string | null; userAgent: string | null }, event: string,
): Promise<string> {
  const now = clock.now();
  const token = b64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await db.batch([
    db.prepare("UPDATE admin_users SET last_login_at = ? WHERE id = ?").bind(now, user.id),
    db.prepare(`INSERT INTO admin_sessions (token_hash, user_id, created_at, expires_at, last_seen_at, ip_hash, user_agent)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(await sha256Hex(token), user.id, now, now + A.sessionHours * 60 * MIN, now, meta.ipHash, meta.userAgent?.slice(0, 300) ?? null),
    db.prepare("DELETE FROM admin_sessions WHERE expires_at <= ? OR last_seen_at <= ?").bind(now, now - A.idleMinutes * MIN),
    audit(db, now, `admin:${user.username}`, event, { ipHash: meta.ipHash }),
  ]);
  return token;
}

/** Active admin with this (lower-case) Google email. */
export async function adminByEmail(db: D1Database, email: string) {
  return db.prepare("SELECT id, username, display_name, must_change FROM admin_users WHERE email = ? AND disabled = 0")
    .bind(email.toLowerCase()).first<AdminUser>();
}

export function sessionToken(req: Request): string | null {
  const cookie = req.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === A.cookieName) return v.join("=") || null;
  }
  return null;
}

export const sessionCookie = (token: string) =>
  `${A.cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${A.sessionHours * 3600}`;
export const clearCookie = () => `${A.cookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

/** The signed-in admin, or null. Refreshes last_seen at most once a minute (fewer writes). */
export async function currentAdmin(db: D1Database, clock: Clock, req: Request): Promise<(AdminUser & { tokenHash: string }) | null> {
  const token = sessionToken(req);
  if (!token || token.length > 100) return null;
  const now = clock.now();
  const tokenHash = await sha256Hex(token);
  const row = await db.prepare(
    `SELECT u.id, u.username, u.display_name, u.must_change, s.last_seen_at FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND s.last_seen_at > ? AND u.disabled = 0`,
  ).bind(tokenHash, now, now - A.idleMinutes * MIN).first<AdminUser & { last_seen_at: number }>();
  if (!row) return null;
  if (now - row.last_seen_at > MIN) {
    await db.prepare("UPDATE admin_sessions SET last_seen_at = ? WHERE token_hash = ?").bind(now, tokenHash).run();
  }
  return { id: row.id, username: row.username, display_name: row.display_name, must_change: row.must_change, tokenHash };
}

export async function logout(db: D1Database, clock: Clock, admin: AdminUser & { tokenHash: string }) {
  await db.batch([
    db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").bind(admin.tokenHash),
    audit(db, clock.now(), `admin:${admin.username}`, "logout", {}),
  ]);
}

/** Change own password. Other sessions of this user are signed out. */
export async function changePassword(db: D1Database, clock: Clock, admin: AdminUser & { tokenHash: string }, current: unknown, next: unknown) {
  const row = await db.prepare("SELECT password_hash FROM admin_users WHERE id = ?").bind(admin.id).first<{ password_hash: string }>();
  if (!row || typeof current !== "string" || !(await verifyPassword(current.slice(0, 200), row.password_hash))) {
    return { ok: false as const, error: "wrong_current_password" };
  }
  const problem = passwordProblem(next, admin.username);
  if (problem) return { ok: false as const, error: problem };
  if (next === current) return { ok: false as const, error: "same_password" };
  const now = clock.now();
  await db.batch([
    db.prepare("UPDATE admin_users SET password_hash = ?, must_change = 0, password_changed_at = ? WHERE id = ?")
      .bind(await hashPassword(next as string), now, admin.id),
    db.prepare("DELETE FROM admin_sessions WHERE user_id = ? AND token_hash != ?").bind(admin.id, admin.tokenHash),
    audit(db, now, `admin:${admin.username}`, "password_changed", {}),
  ]);
  return { ok: true as const };
}

/* ------------------------------------------------------- account management */

export interface AdminRow {
  id: number; username: string; email: string | null; display_name: string; must_change: number; disabled: number;
  locked_until: number | null; created_at: number; last_login_at: number | null;
}

export async function listAdmins(db: D1Database) {
  return (await db.prepare(
    "SELECT id, username, email, display_name, must_change, disabled, locked_until, created_at, last_login_at FROM admin_users ORDER BY username",
  ).all<AdminRow>()).results;
}

type Admin = AdminUser & { tokenHash: string };
type Result = { ok: true; username: string; temporaryPassword?: string } | { ok: false; status: number; error: string; domains?: string };

export const EMAIL_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/;

/**
 * Any admin can add another by Google email. The account signs in with Google only (no password; must_change 0).
 * `domains`: allowed Google domains (empty = any).
 */
export async function createAdmin(db: D1Database, clock: Clock, by: Admin, email: unknown, displayName: unknown, domains: string[] = []): Promise<Result> {
  const mail = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(mail)) return { ok: false, status: 400, error: "invalid_email" };
  if (domains.length && !domains.includes(mail.split("@")[1])) return { ok: false, status: 400, error: "email_domain_not_allowed", domains: domains.join(", ") } as Result;
  if (typeof displayName !== "string" || !displayName.trim() || displayName.length > 100) return { ok: false, status: 400, error: "invalid_display_name" };
  const now = clock.now();
  try {
    await db.batch([
      db.prepare("INSERT INTO admin_users (username, email, display_name, password_hash, must_change, created_at) VALUES (?, ?, ?, '', 0, ?)")
        .bind(mail, mail, displayName.trim(), now),
      audit(db, now, `admin:${by.username}`, "admin_created", { email: mail }),
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE")) return { ok: false, status: 409, error: "email_taken" };
    throw e;
  }
  return { ok: true, username: mail };
}

/** Disabling signs the account out everywhere. You cannot disable yourself (so one active admin always remains). */
export async function setAdminDisabled(db: D1Database, clock: Clock, by: Admin, id: number, disabled: boolean): Promise<Result> {
  if (id === by.id) return { ok: false, status: 400, error: "cannot_disable_self" };
  const target = await db.prepare("SELECT username FROM admin_users WHERE id = ?").bind(id).first<{ username: string }>();
  if (!target) return { ok: false, status: 404, error: "not_found" };
  const now = clock.now();
  await db.batch([
    db.prepare("UPDATE admin_users SET disabled = ? WHERE id = ?").bind(disabled ? 1 : 0, id),
    ...(disabled ? [db.prepare("DELETE FROM admin_sessions WHERE user_id = ?").bind(id)] : []),
    audit(db, now, `admin:${by.username}`, disabled ? "admin_disabled" : "admin_enabled", { username: target.username }),
  ]);
  return { ok: true, username: target.username };
}
