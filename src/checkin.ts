import type { Clock } from "./clock";
import { config } from "./config";
import { nearestPoint, type Point } from "./geo";
import type { LineClient } from "./line";
import { bangkokDateOf, MIN } from "./time";

/**
 * GPS check-in, verified server-side. The member comes ONLY from the LINE-verified ID token.
 * Order (spec 8.2): identity -> assignment -> time window (server clock) -> nonce -> accuracy -> geofence.
 * Every submit is stored in `checkins`, whatever the outcome.
 */

export type CheckinResult = "ok" | "outside_geofence" | "low_accuracy" | "outside_window" | "rejected";

export interface Member { id: number; staff_code: string; label: string; consent_at: number | null }

interface DutyRow {
  id: number;
  member_id: number;
  duty_date: string;
  shift: string;
  start_at: number;
  end_at: number;
  status: string;
  checked_in_at: number | null;
  late: number | null;
  location_id: number;
  location: string;
  allowed_accuracy_m: number;
}

const DUTY_SQL = `
  SELECT d.id, d.member_id, d.duty_date, d.shift, d.start_at, d.end_at, d.status, d.checked_in_at, d.late,
         d.location_id, l.name AS location, l.allowed_accuracy_m
  FROM duties d JOIN locations l ON l.id = d.location_id`;

export const windowOf = (d: { start_at: number; end_at: number }) => ({ opensAt: d.start_at - config.earlyGraceMinutes * MIN, closesAt: d.end_at });

export type Identity = { ok: true; member: Member; userId: string } | { ok: false; status: number; error: string; userId?: string };

/** Verify the ID token with LINE and map `sub` to an active, linked member. */
export async function identify(db: D1Database, line: LineClient, idToken: unknown): Promise<Identity> {
  if (typeof idToken !== "string" || !idToken || idToken.length > 4096) return { ok: false, status: 401, error: "invalid_token" };
  const v = await line.verifyIdToken(idToken); // throws if LINE is unreachable -> caller answers 503
  if (!v.ok) return { ok: false, status: 401, error: "invalid_token" };
  const member = await db.prepare("SELECT id, staff_code, label, consent_at FROM members WHERE line_user_id = ? AND active = 1")
    .bind(v.userId).first<Member>();
  if (!member) return { ok: false, status: 403, error: "not_linked", userId: v.userId };
  return { ok: true, member, userId: v.userId };
}

const view = (d: DutyRow, now: number) => {
  const w = windowOf(d);
  return {
    id: d.id, date: d.duty_date, shift: d.shift, location: d.location, startAt: d.start_at, endAt: d.end_at,
    opensAt: w.opensAt, closesAt: w.closesAt, status: d.status, checkedInAt: d.checked_in_at, late: d.late === 1,
    open: d.status === "PENDING" && now >= w.opensAt && now <= w.closesAt,
  };
};

/**
 * Called when the LIFF page opens: the member's duties for today (Bangkok), and a fresh nonce for the duty that
 * is open now (or the next one today, so a too-early tap is still recorded as outside_window).
 */
export async function startCheckin(db: D1Database, clock: Clock, member: Member) {
  const now = clock.now();
  const today = bangkokDateOf(now);
  const { results } = await db.prepare(`${DUTY_SQL} WHERE d.member_id = ? AND d.duty_date = ? AND d.status != 'CANCELLED' ORDER BY d.start_at`)
    .bind(member.id, today).all<DutyRow>();
  const duties = results.map((d) => view(d, now));
  const target = duties.find((d) => d.open) ?? duties.find((d) => d.status === "PENDING" && d.closesAt > now);
  let nonce: string | null = null;
  if (target) {
    nonce = randomNonce();
    await db.prepare("INSERT INTO nonces (duty_id, member_id, value, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(target.id, member.id, nonce, now, now + config.nonceTtlSeconds * 1000).run();
  }
  return {
    member: { staffCode: member.staff_code, label: member.label },
    needsConsent: member.consent_at == null,
    consentText: config.consentText,
    duties,
    current: target ? { dutyId: target.id, nonce } : null,
    serverNow: now,
  };
}

function randomNonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function recordConsent(db: D1Database, clock: Clock, member: Member) {
  const now = clock.now();
  await db.batch([
    db.prepare("UPDATE members SET consent_at = ? WHERE id = ? AND consent_at IS NULL").bind(now, member.id),
    db.prepare("INSERT INTO audit_log (at, actor, event, detail) SELECT ?, 'member', 'location_consent', json_object('member_id', ?) WHERE changes() = 1")
      .bind(now, member.id),
  ]);
}

export interface SubmitInput {
  dutyId?: unknown;
  nonce?: unknown;
  lat?: unknown;
  lng?: unknown;
  accuracy?: unknown;
  clientTs?: unknown;
}

export interface Attempt {
  dutyId: number | null;
  memberId: number | null;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  clientTs: number | null;
  ipHash: string | null;
  userAgent: string | null;
}

export interface SubmitOutcome {
  status: number;
  result: CheckinResult;
  reason?: string;
  distanceM?: number;
  radiusM?: number;
  allowedAccuracyM?: number;
  duty?: ReturnType<typeof view>;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Store one attempt row. Every submit ends here exactly once. */
function logAttempt(db: D1Database, now: number, a: Attempt, result: CheckinResult, extra: { reason?: string; distanceM?: number; pointId?: number; nonceId?: number } = {}) {
  return db.prepare(
    `INSERT INTO checkins (duty_id, member_id, submitted_at, client_ts, lat, lng, accuracy_m, distance_m, point_id, result, reason,
                           nonce_id, ip_hash, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(a.dutyId, a.memberId, now, a.clientTs, a.lat, a.lng, a.accuracy, extra.distanceM ?? null, extra.pointId ?? null,
    result, extra.reason ?? null, extra.nonceId ?? null, a.ipHash, a.userAgent);
}

/** Log a submit that failed before or at identity (no member known, or member not linked). */
export async function logUnidentified(db: D1Database, clock: Clock, body: SubmitInput, meta: { ipHash: string | null; userAgent: string | null }, reason: string) {
  await logAttempt(db, clock.now(), attemptOf(body, null, meta), "rejected", { reason }).run();
}

/** duty_id starts null and is filled in only once the duty is known to exist and belong to this member. */
function attemptOf(body: SubmitInput, memberId: number | null, meta: { ipHash: string | null; userAgent: string | null }): Attempt {
  return {
    dutyId: null, memberId, lat: num(body.lat), lng: num(body.lng), accuracy: num(body.accuracy), clientTs: num(body.clientTs),
    ipHash: meta.ipHash, userAgent: meta.userAgent?.slice(0, 300) ?? null,
  };
}

export async function submitCheckin(
  db: D1Database, clock: Clock, member: Member, body: SubmitInput, meta: { ipHash: string | null; userAgent: string | null },
): Promise<SubmitOutcome> {
  const now = clock.now();
  const a = attemptOf(body, member.id, meta);
  const reject = async (status: number, reason: string, result: CheckinResult = "rejected", extra: Parameters<typeof logAttempt>[4] = {}) => {
    await logAttempt(db, now, a, result, { reason, ...extra }).run();
    return { status, result, reason } as SubmitOutcome;
  };

  // Rate limit per member, counted from the attempts table itself.
  const recent = await db.prepare("SELECT COUNT(*) AS n FROM checkins WHERE member_id = ? AND submitted_at > ?")
    .bind(member.id, now - config.checkinRateLimit.windowMinutes * MIN).first<{ n: number }>();
  if ((recent?.n ?? 0) >= config.checkinRateLimit.max) return reject(429, "rate_limited");
  if (member.consent_at == null) return reject(403, "no_consent");

  // 2. Assignment: the duty exists, belongs to this member, and is live.
  const dutyId = num(body.dutyId);
  const duty = dutyId != null && Number.isInteger(dutyId) ? await db.prepare(`${DUTY_SQL} WHERE d.id = ?`).bind(dutyId).first<DutyRow>() : null;
  if (!duty || duty.member_id !== member.id) return reject(403, "not_your_duty");
  a.dutyId = duty.id;
  if (duty.status === "CANCELLED") return reject(409, "duty_cancelled");
  if (duty.status === "CHECKED_IN") {
    // Double submit: idempotent, report what is already true.
    await logAttempt(db, now, a, "rejected", { reason: "already_checked_in" }).run();
    return { status: 200, result: "ok", reason: "already_checked_in", duty: view(duty, now) };
  }

  // 3. Time window, server clock only.
  const w = windowOf(duty);
  if (now < w.opensAt) return reject(422, "too_early", "outside_window");
  if (now > w.closesAt || duty.status === "MISSED") return reject(422, "too_late", "outside_window");

  // 4. Nonce: issued for this member AND duty, unexpired, unused. Consumed atomically; of two concurrent
  // submits with the same nonce exactly one gets the row back.
  const nonce = typeof body.nonce === "string" && body.nonce.length <= 64 ? body.nonce : "";
  const used = await db.prepare(
    `UPDATE nonces SET used_at = ?1 WHERE value = ?2 AND member_id = ?3 AND duty_id = ?4 AND used_at IS NULL AND expires_at > ?1
     RETURNING id`,
  ).bind(now, nonce, member.id, duty.id).first<{ id: number }>();
  if (!used) {
    const n = nonce ? await db.prepare("SELECT member_id, duty_id, expires_at, used_at FROM nonces WHERE value = ?").bind(nonce)
      .first<{ member_id: number; duty_id: number; expires_at: number; used_at: number | null }>() : null;
    const reason = !n || n.member_id !== member.id || n.duty_id !== duty.id ? "bad_nonce" : n.used_at != null ? "nonce_used" : "nonce_expired";
    return reject(409, reason);
  }
  const nonceId = used.id;

  // Coordinates must be plausible numbers before any maths.
  if (a.lat == null || a.lng == null || a.accuracy == null || Math.abs(a.lat) > 90 || Math.abs(a.lng) > 180 || a.accuracy < 0) {
    return reject(400, "bad_coords", "rejected", { nonceId });
  }

  const points = (await db.prepare("SELECT id, lat, lng, radius_m FROM geofence_points WHERE location_id = ?").bind(duty.location_id).all<Point>()).results;
  const near = nearestPoint(a.lat, a.lng, points);
  if (!near) return reject(500, "location_has_no_points", "rejected", { nonceId });
  const geo = { distanceM: Math.round(near.distanceM * 10) / 10, pointId: near.point.id, nonceId };
  const detail = { distanceM: geo.distanceM, radiusM: near.point.radius_m, allowedAccuracyM: duty.allowed_accuracy_m };

  // 5. Accuracy, then 6. geofence. Distance is stored in both cases.
  if (a.accuracy > duty.allowed_accuracy_m) {
    await logAttempt(db, now, a, "low_accuracy", geo).run();
    return { status: 422, result: "low_accuracy", ...detail };
  }
  if (!near.inside) {
    await logAttempt(db, now, a, "outside_geofence", geo).run();
    return { status: 422, result: "outside_geofence", ...detail };
  }

  // 7. Success: attempt row + duty change in one transaction. The conditional UPDATE makes two different
  // successful nonces for the same duty harmless: only the first changes it.
  const late = now > duty.start_at + config.lateAfterMinutes * MIN ? 1 : 0;
  await db.batch([
    logAttempt(db, now, a, "ok", geo),
    db.prepare(
      `UPDATE duties SET status = 'CHECKED_IN', checked_in_at = ?1, late = ?2, source = 'gps', updated_at = ?1
       WHERE id = ?3 AND status = 'PENDING'`,
    ).bind(now, late, duty.id),
  ]);
  const fresh = await db.prepare(`${DUTY_SQL} WHERE d.id = ?`).bind(duty.id).first<DutyRow>();
  return { status: 200, result: "ok", ...detail, duty: view(fresh!, now) };
}
