import type { WaitUntil } from "./app";
import { sendConfirm } from "./app";
import {
  changePassword, clearCookie, createAdmin, currentAdmin, EMAIL_RE, listAdmins, login, logout, sessionCookie, setAdminDisabled,
  type AdminUser,
} from "./auth";
import { confirmKeys, queueConfirm } from "./checkin";
import type { Clock } from "./clock";
import { config } from "./config";
import type { Env } from "./index";
import { publishImport, stageImport } from "./importer";
import type { LineClient } from "./line";
import { allowedDomains, googleConfigured } from "./google";
import { attemptsFor, buildToday, exportCsv } from "./report";
import { emailClientFor } from "./email";
import { buildTestEmail } from "./messages";
import { saveSchedule, scheduleInfo } from "./settings";
import { addDays, bangkokDateOf, bangkokTimeOf } from "./time";
import { isStr, json, readJson } from "./util";

/**
 * Admin API. Errors are codes ({error: "code", ...params}); the pages translate them (EN/TH).
 */

/** Dev/perf only (/dev/*): the ADMIN_TOKEN bearer. Admin pages and /admin/api use the login session instead. */
export function devAuthorized(req: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN) return false;
  return req.headers.get("authorization") === `Bearer ${env.ADMIN_TOKEN}`;
}

/** State-changing requests must come from our own pages (on top of the SameSite=Strict cookie). */
function sameOrigin(req: Request): boolean {
  return req.method === "GET" || req.headers.get("origin") === new URL(req.url).origin;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Staff and location codes. Dots allowed (e.g. "first.la"). */
const CODE_RE = /^[A-Za-z0-9._-]{1,32}$/;
/** Longest range the duty sheet loads at once. */
const SHEET_MAX_DAYS = 31;

export async function handleAdmin(
  req: Request, env: Env, clock: Clock, path: string, url: URL, ipHash: string | null, line?: LineClient, waitUntil?: WaitUntil,
): Promise<Response> {
  const db = env.DB;
  const now = clock.now();
  if (!sameOrigin(req)) return json({ error: "cross_origin" }, 403);

  if (req.method === "GET" && path === "/admin/api/login-options") {
    return json({ google: googleConfigured(env), password: env.ALLOW_PASSWORD_LOGIN === "1", domains: allowedDomains(env) });
  }
  if (req.method === "POST" && path === "/admin/api/login") {
    if (env.ALLOW_PASSWORD_LOGIN !== "1") return json({ error: "password_login_disabled" }, 404);
    if (env.IP_LIMIT && ipHash && !(await env.IP_LIMIT.limit({ key: `login:${ipHash}` })).success) return json({ error: "rate_limited" }, 429);
    const b = await readJson(req);
    const res = await login(db, clock, b?.username, b?.password, { ipHash, userAgent: req.headers.get("user-agent") });
    if (!res.ok) return json({ error: res.error, retryAt: res.retryAt }, res.error === "locked" ? 429 : 401);
    return json({ user: me(res.user) }, 200, { "set-cookie": sessionCookie(res.token) });
  }

  const admin = await currentAdmin(db, clock, req);
  if (!admin) return json({ error: "not_signed_in" }, 401, { "set-cookie": clearCookie() });
  if (req.method === "GET" && path === "/admin/api/me") return json({ user: me(admin) });
  if (req.method === "POST" && path === "/admin/api/logout") {
    await logout(db, clock, admin);
    return json({ ok: true }, 200, { "set-cookie": clearCookie() });
  }
  if (req.method === "POST" && path === "/admin/api/password") {
    const b = await readJson(req);
    const res = await changePassword(db, clock, admin, b?.current, b?.next);
    return res.ok ? json({ ok: true }) : json({ error: res.error, min: config.auth.minPasswordLength }, 422);
  }
  // A temporary password must be replaced before anything else.
  if (admin.must_change) return json({ error: "must_change_password" }, 403);

  const actor = `admin:${admin.username}`;
  const audit = (at: number, event: string, detail: unknown) =>
    db.prepare("INSERT INTO audit_log (at, actor, event, detail) VALUES (?, ?, ?, ?)").bind(at, actor, event, JSON.stringify(detail));
  const route = `${req.method} ${path.replace(/\/\d+(?=\/|$)/g, "/:id")}`;
  const id = Number(/\/(\d+)(?:\/|$)/.exec(path)?.[1]);

  switch (route) {
    /* ------------------------------------------------------------- members */
    case "GET /admin/api/members": {
      const { results } = await db.prepare(
        `SELECT id, staff_code, label, grp, email, active, line_user_id IS NOT NULL AS linked, linked_at, consent_at FROM members ORDER BY staff_code`,
      ).all();
      return json({ members: results });
    }
    case "POST /admin/api/members": {
      // Upsert [{staffCode, label, email?, group?, active?}]. The email is the member's Google account (used to link LINE).
      const body = await readJson(req);
      const list = body?.members;
      if (!Array.isArray(list) || !list.length || list.length > 1000) return json({ error: "members_required" }, 400);
      const bad = list.findIndex((m) => !CODE_RE.test(m?.staffCode ?? "") || !isStr(m?.label, 100));
      if (bad >= 0) return json({ error: "invalid_member", index: bad + 1 }, 400);
      const domains = allowedDomains(env);
      const emails = list.map((m) => (typeof m.email === "string" && m.email.trim() ? m.email.trim().toLowerCase() : null));
      const badMail = emails.findIndex((e) => e !== null && (!EMAIL_RE.test(e) || (domains.length > 0 && !domains.includes(e.split("@")[1]))));
      if (badMail >= 0) return json({ error: "invalid_member_email", index: badMail + 1, domains: domains.join(", ") }, 400);
      const dup = emails.findIndex((e, i) => e !== null && emails.indexOf(e) !== i);
      if (dup >= 0) return json({ error: "duplicate_member_email", index: dup + 1 }, 400);
      try {
        await db.batch([
          ...list.map((m, i) => db.prepare(
            `INSERT INTO members (staff_code, label, grp, email, active, created_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (staff_code) DO UPDATE SET label = excluded.label, grp = excluded.grp, active = excluded.active,
               email = COALESCE(excluded.email, members.email)`,
          ).bind(m.staffCode, m.label, typeof m.group === "string" ? m.group.slice(0, 50) : null, emails[i], m.active === false ? 0 : 1, now)),
          audit(now, "members_upserted", { count: list.length }),
        ]);
      } catch (e) {
        if (String(e).includes("UNIQUE") && String(e).includes("email")) return json({ error: "email_used_by_other_member" }, 409);
        throw e;
      }
      return json({ ok: true, count: list.length });
    }
    case "POST /admin/api/members/:id/unlink": {
      await db.batch([
        db.prepare("UPDATE members SET line_user_id = NULL, linked_at = NULL WHERE id = ?").bind(id),
        audit(now, "member_unlinked", { memberId: id }),
      ]);
      return json({ ok: true });
    }

    /* ----------------------------------------------------------- locations */
    case "GET /admin/api/locations": {
      const [locs, pts] = await Promise.all([
        db.prepare("SELECT id, code, name, allowed_accuracy_m, active FROM locations ORDER BY code").all<{ id: number }>(),
        db.prepare("SELECT id, location_id, label, lat, lng, radius_m FROM geofence_points WHERE retired_at IS NULL ORDER BY id").all<{ location_id: number }>(),
      ]);
      return json({
        defaults: { radiusM: config.defaultRadiusM, allowedAccuracyM: config.defaultAllowedAccuracyM },
        locations: locs.results.map((l) => ({ ...l, points: pts.results.filter((p) => p.location_id === l.id) })),
      });
    }
    case "POST /admin/api/locations": {
      // Upsert one location by code; `points` replaces its geofence points (old ones are retired, not deleted).
      const b = await readJson(req);
      const [rMin, rMax] = config.radiusRangeM, [aMin, aMax] = config.accuracyRangeM;
      const acc = b?.allowedAccuracyM ?? config.defaultAllowedAccuracyM;
      const points = b?.points;
      if (!b || !CODE_RE.test(String(b.code ?? "")) || !isStr(b.name, 100)) return json({ error: "code_name_required" }, 400);
      if (typeof acc !== "number" || acc < aMin || acc > aMax) return json({ error: "accuracy_out_of_range", min: aMin, max: aMax }, 400);
      if (!Array.isArray(points) || !points.length || points.length > 20) return json({ error: "points_required" }, 400);
      for (const p of points) {
        const r = p?.radiusM ?? config.defaultRadiusM;
        if (typeof p?.lat !== "number" || typeof p?.lng !== "number" || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) {
          return json({ error: "invalid_point" }, 400);
        }
        if (typeof r !== "number" || r < rMin || r > rMax) return json({ error: "radius_out_of_range", min: rMin, max: rMax }, 400);
      }
      const loc = await db.prepare(
        `INSERT INTO locations (code, name, allowed_accuracy_m, active) VALUES (?, ?, ?, ?)
         ON CONFLICT (code) DO UPDATE SET name = excluded.name, allowed_accuracy_m = excluded.allowed_accuracy_m, active = excluded.active
         RETURNING id`,
      ).bind(b.code, b.name, Math.round(acc), b.active === false ? 0 : 1).first<{ id: number }>();
      await db.batch([
        db.prepare("UPDATE geofence_points SET retired_at = ? WHERE location_id = ? AND retired_at IS NULL").bind(now, loc!.id),
        ...points.map((p: { lat: number; lng: number; radiusM?: number; label?: string }) =>
          db.prepare("INSERT INTO geofence_points (location_id, label, lat, lng, radius_m) VALUES (?, ?, ?, ?, ?)")
            .bind(loc!.id, typeof p.label === "string" ? p.label.slice(0, 50) : null, p.lat, p.lng, Math.round(p.radiusM ?? config.defaultRadiusM))),
        audit(now, "location_saved", { code: b.code, points: points.length, allowedAccuracyM: acc }),
      ]);
      return json({ ok: true, id: loc!.id });
    }

    /* ------------------------------------------------- roster (file + sheet) */
    case "POST /admin/api/imports": {
      const res = await stageImport(db, clock, await req.json().catch(() => null));
      return res.ok ? json(res.value, 201) : json({ errors: res.errors }, 422);
    }
    case "POST /admin/api/imports/:id/publish": {
      const res = await publishImport(db, clock, id, actor);
      return res.ok ? json(res.value) : json({ errors: res.errors }, res.status ?? 422);
    }
    case "GET /admin/api/duties": {
      // Everything the duty sheet needs for a date range. The sheet publishes through /imports like a file.
      const from = url.searchParams.get("from") ?? "", to = url.searchParams.get("to") ?? "";
      if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from) return json({ error: "invalid_range" }, 400);
      if (to > addDays(from, SHEET_MAX_DAYS - 1)) return json({ error: "range_too_long", max: SHEET_MAX_DAYS }, 400);
      const [members, locations, duties, known] = await Promise.all([
        db.prepare("SELECT id, staff_code AS staffCode, label FROM members WHERE active = 1 ORDER BY staff_code").all(),
        db.prepare(`SELECT code, name FROM locations l WHERE active = 1
                    AND EXISTS (SELECT 1 FROM geofence_points p WHERE p.location_id = l.id AND p.retired_at IS NULL) ORDER BY code`).all(),
        db.prepare(`SELECT d.id, m.staff_code, d.duty_date, d.shift, l.code AS location_code, d.start_at, d.end_at, d.status
                    FROM duties d JOIN members m ON m.id = d.member_id JOIN locations l ON l.id = d.location_id
                    WHERE d.duty_date BETWEEN ? AND ? AND d.status != 'CANCELLED' ORDER BY d.duty_date, d.start_at`).bind(from, to)
          .all<{ id: number; staff_code: string; duty_date: string; shift: string; location_code: string; start_at: number; end_at: number; status: string }>(),
        db.prepare("SELECT duty_date FROM roster_dates WHERE duty_date BETWEEN ? AND ?").bind(from, to).all<{ duty_date: string }>(),
      ]);
      return json({
        from, to, shifts: config.shiftList,
        members: members.results, locations: locations.results, knownDates: known.results.map((r) => r.duty_date),
        duties: duties.results.map((d) => ({
          id: d.id, staffCode: d.staff_code, date: d.duty_date, shift: d.shift, locationCode: d.location_code,
          start: bangkokTimeOf(d.start_at), end: bangkokTimeOf(d.end_at), status: d.status,
        })),
      });
    }

    /* ------------------------------------------------------- day dashboard */
    case "GET /admin/api/today": {
      const date = url.searchParams.get("date") ?? undefined;
      if (date && !DATE_RE.test(date)) return json({ error: "invalid_date" }, 400);
      return json(await buildToday(db, clock, date));
    }
    case "GET /admin/api/checkins": {
      const date = url.searchParams.get("date") ?? bangkokDateOf(now);
      if (!DATE_RE.test(date)) return json({ error: "invalid_date" }, 400);
      return json({ date, attempts: await attemptsFor(db, date) });
    }
    case "POST /admin/api/duties/:id/override": {
      // Manual check-in for a legitimate GPS failure. A note is required and audited.
      const b = await readJson(req);
      const note = typeof b?.note === "string" ? b.note.trim() : "";
      if (note.length < 3 || note.length > 500) return json({ error: "note_required" }, 400);
      const late = b?.late === true ? 1 : 0;
      const [upd] = await db.batch([
        db.prepare(
          `UPDATE duties SET status = 'CHECKED_IN', checked_in_at = ?1, late = ?2, source = 'override', override_note = ?3,
                  override_by = ?5, updated_at = ?1
           WHERE id = ?4 AND status IN ('PENDING', 'MISSED')`,
        ).bind(now, late, note, id, admin.username),
        db.prepare("INSERT INTO audit_log (at, actor, event, detail) SELECT ?, ?, 'duty_override', ? WHERE changes() = 1")
          .bind(now, actor, JSON.stringify({ dutyId: id, note, late })),
        ...queueConfirm(db, now, id),
      ]);
      if (upd.meta.changes !== 1) return json({ error: "override_conflict" }, 409);
      if (config.confirmOnCheckin) sendConfirm(env, clock, line, confirmKeys(id), waitUntil);
      return json({ ok: true });
    }
    case "GET /admin/api/export.csv": {
      const from = url.searchParams.get("from") ?? "", to = url.searchParams.get("to") ?? from;
      if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from) return json({ error: "invalid_range" }, 400);
      return new Response(await exportCsv(db, from, to), {
        headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="checkins-${from}_${to}.csv"` },
      });
    }

    /* ------------------------------------------------- scheduling settings */
    case "GET /admin/api/settings":
      return json({ ...(await scheduleInfo(db)), emailConfigured: !!(emailClientFor(env) && env.PUBLIC_URL) });
    case "POST /admin/api/email/test": {
      // Sends one test message to the signed-in admin's Google email, to check the SMTP settings.
      const email = emailClientFor(env);
      if (!email || !env.PUBLIC_URL) return json({ error: "email_not_configured" }, 503);
      const row = await db.prepare("SELECT email FROM admin_users WHERE id = ?").bind(admin.id).first<{ email: string | null }>();
      if (!row?.email) return json({ error: "admin_has_no_email" }, 400);
      let r;
      try {
        r = await email.send({ to: row.email, ...buildTestEmail(env.PUBLIC_URL), messageId: `<test-${crypto.randomUUID()}@${new URL(env.PUBLIC_URL).hostname}>` });
      } catch (e) {
        r = { kind: "temporary" as const, message: String(e) };
      }
      await audit(now, "email_test", { to: row.email, result: r.kind }).run();
      return r.kind === "accepted" ? json({ ok: true, to: row.email }) : json({ error: "email_send_failed", detail: r.message.slice(0, 200) }, 502);
    }
    case "POST /admin/api/settings": {
      const res = await saveSchedule(db, clock, actor, await readJson(req));
      return res.ok ? json({ ok: true, schedule: res.value, replanned: res.replanned }) : json({ error: res.error, field: res.field }, 400);
    }

    /* ------------------------------------------------- management accounts */
    case "GET /admin/api/admins": {
      const rows = await listAdmins(db);
      return json({
        self: admin.id,
        admins: rows.map((r) => ({
          id: r.id, username: r.username, email: r.email, displayName: r.display_name, mustChange: r.must_change === 1, disabled: r.disabled === 1,
          locked: (r.locked_until ?? 0) > now, createdAt: r.created_at, lastLoginAt: r.last_login_at,
        })),
      });
    }
    case "POST /admin/api/admins": {
      const b = await readJson(req);
      const res = await createAdmin(db, clock, admin, b?.email, b?.displayName, allowedDomains(env));
      return res.ok ? json(res, 201) : json({ error: res.error, domains: res.domains }, res.status);
    }
    case "POST /admin/api/admins/:id/disable":
    case "POST /admin/api/admins/:id/enable": {
      const res = await setAdminDisabled(db, clock, admin, id, route.endsWith("disable"));
      return res.ok ? json(res) : json({ error: res.error }, res.status);
    }
  }
  return json({ error: "not_found" }, 404);
}

const me = (u: AdminUser) => ({ username: u.username, displayName: u.display_name, mustChange: u.must_change === 1 });
