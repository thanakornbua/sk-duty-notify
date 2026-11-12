import type { WaitUntil } from "./app";
import { sendConfirm } from "./app";
import { recordConsent, startCheckin, submitCheckin, type Member } from "./checkin";
import type { Clock } from "./clock";
import { config } from "./config";
import type { Env } from "./index";
import type { LineClient } from "./line";
import { addDays, bangkokDateOf, MIN } from "./time";
import { json, readJson, sha256Hex } from "./util";

/**
 * Member portal (/me): a member signs in with the Google account on the roster (src/google.ts, purpose "portal")
 * and sees their own duties and check-in attempts, and can check in from the browser (same verification as the
 * LIFF page: assignment -> window -> nonce -> accuracy -> geofence; identity is the Google-verified session).
 * Session: HttpOnly, Secure, SameSite=Lax `__Host-` cookie (Lax so the link in a notice email opens signed in),
 * Origin check on every POST. Raw coordinates are never returned here.
 */

const P = config.portal;
const DAY = 1440 * MIN;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Longest range of records returned at once. */
const MAX_DAYS = 400;

const b64url = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const memberCookie = (token: string) => `${P.cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${P.sessionDays * 86400}`;
const clearMemberCookie = () => `${P.cookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/** New portal session for a verified member. Returns the raw token; only its hash is stored. */
export async function createMemberSession(
  db: D1Database, clock: Clock, memberId: number, meta: { ipHash: string | null; userAgent: string | null },
): Promise<string> {
  const now = clock.now();
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await db.batch([
    db.prepare(`INSERT INTO member_sessions (token_hash, member_id, created_at, expires_at, last_seen_at, ip_hash, user_agent)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(await sha256Hex(token), memberId, now, now + P.sessionDays * DAY, now, meta.ipHash, meta.userAgent?.slice(0, 300) ?? null),
    db.prepare("DELETE FROM member_sessions WHERE expires_at <= ? OR last_seen_at <= ?").bind(now, now - P.idleDays * DAY),
    db.prepare("INSERT INTO audit_log (at, actor, event, detail) VALUES (?, 'member', 'portal_login', ?)")
      .bind(now, JSON.stringify({ member_id: memberId, ipHash: meta.ipHash })),
  ]);
  return token;
}

export const memberByEmail = (db: D1Database, email: string) =>
  db.prepare("SELECT id, staff_code, label FROM members WHERE email = ? AND active = 1").bind(email.toLowerCase())
    .first<{ id: number; staff_code: string; label: string }>();

type PortalMember = Member & { email: string | null; grp: string | null; linked: number; tokenHash: string };

function tokenOf(req: Request): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === P.cookieName) return v.join("=") || null;
  }
  return null;
}

/** The signed-in, active member, or null. Refreshes last_seen at most once an hour. */
export async function currentMember(db: D1Database, clock: Clock, req: Request): Promise<PortalMember | null> {
  const token = tokenOf(req);
  if (!token || token.length > 100) return null;
  const now = clock.now();
  const tokenHash = await sha256Hex(token);
  const row = await db.prepare(
    `SELECT m.id, m.staff_code, m.label, m.consent_at, m.email, m.grp, m.line_user_id IS NOT NULL AS linked, s.last_seen_at
     FROM member_sessions s JOIN members m ON m.id = s.member_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND s.last_seen_at > ? AND m.active = 1`,
  ).bind(tokenHash, now, now - P.idleDays * DAY).first<Omit<PortalMember, "tokenHash"> & { last_seen_at: number }>();
  if (!row) return null;
  if (now - row.last_seen_at > 60 * MIN) {
    await db.prepare("UPDATE member_sessions SET last_seen_at = ? WHERE token_hash = ?").bind(now, tokenHash).run();
  }
  const { last_seen_at: _, ...m } = row;
  return { ...m, tokenHash };
}

interface RecordRow {
  id: number; duty_date: string; shift: string; start_at: number; end_at: number; status: string; late: number | null;
  checked_in_at: number | null; source: string | null; location: string;
}

/** The member's duties in [from, to] with their attempts (no coordinates), plus totals. */
export async function memberRecords(db: D1Database, memberId: number, from: string, to: string) {
  const [duties, attempts] = await Promise.all([
    db.prepare(`SELECT d.id, d.duty_date, d.shift, d.start_at, d.end_at, d.status, d.late, d.checked_in_at, d.source, l.name AS location
                FROM duties d JOIN locations l ON l.id = d.location_id
                WHERE d.member_id = ? AND d.duty_date BETWEEN ? AND ? AND d.status != 'CANCELLED'
                ORDER BY d.start_at DESC`).bind(memberId, from, to).all<RecordRow>(),
    db.prepare(`SELECT c.duty_id, c.submitted_at, c.result, c.reason, c.distance_m, c.accuracy_m, c.via
                FROM checkins c JOIN duties d ON d.id = c.duty_id
                WHERE c.member_id = ? AND d.duty_date BETWEEN ? AND ? ORDER BY c.submitted_at`).bind(memberId, from, to)
      .all<{ duty_id: number; submitted_at: number; result: string; reason: string | null; distance_m: number | null; accuracy_m: number | null; via: string | null }>(),
  ]);
  const rows = duties.results.map((d) => ({
    id: d.id, date: d.duty_date, shift: d.shift, location: d.location, startAt: d.start_at, endAt: d.end_at, status: d.status,
    late: d.late === 1, checkedInAt: d.checked_in_at, source: d.source,
    attempts: attempts.results.filter((a) => a.duty_id === d.id).map((a) => ({
      at: a.submitted_at, result: a.result, reason: a.reason, distanceM: a.distance_m, accuracyM: a.accuracy_m, via: a.via,
    })),
  }));
  const n = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).length;
  return {
    from, to, duties: rows,
    totals: {
      total: rows.length, checkedIn: n((r) => r.status === "CHECKED_IN"), late: n((r) => r.late), missed: n((r) => r.status === "MISSED"),
      pending: n((r) => r.status === "PENDING"),
    },
  };
}

export async function handlePortal(
  req: Request, env: Env, clock: Clock, path: string, url: URL, ipHash: string | null, line?: LineClient, waitUntil?: WaitUntil,
): Promise<Response> {
  const db = env.DB;
  if (req.method !== "GET" && req.headers.get("origin") !== url.origin) return json({ error: "cross_origin" }, 403);
  if (req.method === "POST" && env.IP_LIMIT && ipHash && !(await env.IP_LIMIT.limit({ key: ipHash })).success) {
    return json({ error: "rate_limited" }, 429);
  }
  const member = await currentMember(db, clock, req);
  if (!member) return json({ error: "not_signed_in" }, 401, { "set-cookie": clearMemberCookie() });
  const meta = { ipHash, userAgent: req.headers.get("user-agent"), via: "web" as const };

  switch (`${req.method} ${path}`) {
    case "GET /me/api/me":
      return json({
        member: {
          staffCode: member.staff_code, label: member.label, email: member.email, group: member.grp,
          linked: member.linked === 1, consent: member.consent_at != null,
        },
      });
    case "GET /me/api/records": {
      const today = bangkokDateOf(clock.now());
      const from = url.searchParams.get("from") ?? addDays(today, -90);
      const to = url.searchParams.get("to") ?? addDays(today, 30);
      if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from) return json({ error: "invalid_range" }, 400);
      if (to > addDays(from, MAX_DAYS)) return json({ error: "range_too_long", max: MAX_DAYS }, 400);
      return json({ today, ...(await memberRecords(db, member.id, from, to)) });
    }
    case "POST /me/api/logout":
      await db.prepare("DELETE FROM member_sessions WHERE token_hash = ?").bind(member.tokenHash).run();
      return json({ ok: true }, 200, { "set-cookie": clearMemberCookie() });
    case "POST /me/api/checkin/start":
      return json(await startCheckin(db, clock, member));
    case "POST /me/api/consent":
      await recordConsent(db, clock, member);
      return json({ ok: true });
    case "POST /me/api/checkin/submit": {
      const body = await readJson(req);
      if (!body) return json({ error: "bad json" }, 400);
      const { status, confirmKeys, ...rest } = await submitCheckin(db, clock, member, body, meta);
      if (confirmKeys) sendConfirm(env, clock, line, confirmKeys, waitUntil);
      return json({ ...rest, confirmQueued: !!confirmKeys }, status);
    }
  }
  return json({ error: "not_found" }, 404);
}
