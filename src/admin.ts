import { changePassword, clearCookie, currentAdmin, login, logout, sessionCookie, type AdminUser } from "./auth";
import type { Clock } from "./clock";
import { config } from "./config";
import type { Env } from "./index";
import { publishImport, stageImport } from "./importer";
import { issueLinkCode } from "./linking";
import { attemptsFor, buildToday, exportCsv } from "./report";
import { bangkokDateOf } from "./time";
import { isStr, json, readJson } from "./util";

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

export async function handleAdmin(req: Request, env: Env, clock: Clock, path: string, url: URL, ipHash: string | null): Promise<Response> {
  const db = env.DB;
  const now = clock.now();
  if (!sameOrigin(req)) return json({ error: "cross-origin request refused" }, 403);

  if (req.method === "POST" && path === "/admin/api/login") {
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
    return res.ok ? json({ ok: true }) : json({ error: res.error }, 422);
  }
  // A temporary password must be replaced before anything else.
  if (admin.must_change) return json({ error: "must_change_password" }, 403);

  const actor = `admin:${admin.username}`;
  const audit = (at: number, event: string, detail: unknown) =>
    db.prepare("INSERT INTO audit_log (at, actor, event, detail) VALUES (?, ?, ?, ?)").bind(at, actor, event, JSON.stringify(detail));
  const route = `${req.method} ${path.replace(/\/\d+(?=\/|$)/g, "/:id")}`;
  const id = Number(/\/(\d+)(?:\/|$)/.exec(path)?.[1]);

  switch (route) {
    case "GET /admin/api/members": {
      const { results } = await db.prepare(
        `SELECT id, staff_code, label, grp, active, line_user_id IS NOT NULL AS linked, linked_at, consent_at FROM members ORDER BY staff_code`,
      ).all();
      return json({ members: results });
    }
    case "POST /admin/api/members": {
      // Upsert [{staffCode, label, group?, active?}]. Synthetic data only in this repo.
      const body = await readJson(req);
      const list = body?.members;
      if (!Array.isArray(list) || !list.length || list.length > 1000) return json({ error: "expected {members: [...]} (1-1000)" }, 400);
      const bad = list.findIndex((m) => !CODE_RE.test(m?.staffCode ?? "") || !isStr(m?.label, 100));
      if (bad >= 0) return json({ error: `member ${bad + 1}: staff code (letters, digits, . _ -, max 32) and name (1-100 chars) required` }, 400);
      await db.batch([
        ...list.map((m) => db.prepare(
          `INSERT INTO members (staff_code, label, grp, active, created_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (staff_code) DO UPDATE SET label = excluded.label, grp = excluded.grp, active = excluded.active`,
        ).bind(m.staffCode, m.label, typeof m.group === "string" ? m.group.slice(0, 50) : null, m.active === false ? 0 : 1, now)),
        audit(now, "members_upserted", { count: list.length }),
      ]);
      return json({ ok: true, count: list.length });
    }
    case "POST /admin/api/members/:id/link-code": {
      const m = await db.prepare("SELECT id FROM members WHERE id = ? AND active = 1").bind(id).first();
      if (!m) return json({ error: "unknown or inactive member" }, 404);
      return json(await issueLinkCode(db, clock, id, actor), 201);
    }
    case "POST /admin/api/members/:id/unlink": {
      await db.batch([
        db.prepare("UPDATE members SET line_user_id = NULL, linked_at = NULL WHERE id = ?").bind(id),
        audit(now, "member_unlinked", { memberId: id }),
      ]);
      return json({ ok: true });
    }

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
      // Upsert one location by code; `points` replaces all of its geofence points.
      const b = await readJson(req);
      const [rMin, rMax] = config.radiusRangeM, [aMin, aMax] = config.accuracyRangeM;
      const acc = b?.allowedAccuracyM ?? config.defaultAllowedAccuracyM;
      const points = b?.points;
      if (!b || !CODE_RE.test(String(b.code ?? "")) || !isStr(b.name, 100)) return json({ error: "code and name required" }, 400);
      if (typeof acc !== "number" || acc < aMin || acc > aMax) return json({ error: `allowedAccuracyM must be ${aMin}-${aMax}` }, 400);
      if (!Array.isArray(points) || !points.length || points.length > 20) return json({ error: "1-20 points required" }, 400);
      for (const p of points) {
        const r = p?.radiusM ?? config.defaultRadiusM;
        if (typeof p?.lat !== "number" || typeof p?.lng !== "number" || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) {
          return json({ error: "each point needs numeric lat (-90..90) and lng (-180..180)" }, 400);
        }
        if (typeof r !== "number" || r < rMin || r > rMax) return json({ error: `radiusM must be ${rMin}-${rMax}` }, 400);
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

    case "POST /admin/api/imports": {
      const res = await stageImport(db, clock, await req.json().catch(() => null));
      return res.ok ? json(res.value, 201) : json({ errors: res.errors }, 422);
    }
    case "POST /admin/api/imports/:id/publish": {
      const res = await publishImport(db, clock, id, actor);
      return res.ok ? json(res.value) : json({ errors: res.errors }, res.status ?? 422);
    }

    case "GET /admin/api/today": {
      const date = url.searchParams.get("date") ?? undefined;
      if (date && !DATE_RE.test(date)) return json({ error: "date must be YYYY-MM-DD" }, 400);
      return json(await buildToday(db, clock, date));
    }
    case "GET /admin/api/checkins": {
      const date = url.searchParams.get("date") ?? bangkokDateOf(now);
      if (!DATE_RE.test(date)) return json({ error: "date must be YYYY-MM-DD" }, 400);
      return json({ date, attempts: await attemptsFor(db, date) });
    }
    case "POST /admin/api/duties/:id/override": {
      // Manual check-in for a legitimate GPS failure. A note is required and audited.
      const b = await readJson(req);
      const note = typeof b?.note === "string" ? b.note.trim() : "";
      if (note.length < 3 || note.length > 500) return json({ error: "note (3-500 chars) required" }, 400);
      const late = b?.late === true ? 1 : 0;
      const [upd] = await db.batch([
        db.prepare(
          `UPDATE duties SET status = 'CHECKED_IN', checked_in_at = ?1, late = ?2, source = 'override', override_note = ?3,
                  override_by = ?5, updated_at = ?1
           WHERE id = ?4 AND status IN ('PENDING', 'MISSED')`,
        ).bind(now, late, note, id, admin.username),
        db.prepare("INSERT INTO audit_log (at, actor, event, detail) SELECT ?, ?, 'duty_override', ? WHERE changes() = 1")
          .bind(now, actor, JSON.stringify({ dutyId: id, note, late })),
      ]);
      if (upd.meta.changes !== 1) return json({ error: "duty not found, cancelled, or already checked in" }, 409);
      return json({ ok: true });
    }
    case "GET /admin/api/export.csv": {
      const from = url.searchParams.get("from") ?? "", to = url.searchParams.get("to") ?? from;
      if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from) return json({ error: "from/to must be YYYY-MM-DD, from <= to" }, 400);
      return new Response(await exportCsv(db, from, to), {
        headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="checkins-${from}_${to}.csv"` },
      });
    }
  }
  return json({ error: "not found" }, 404);
}

const me = (u: AdminUser) => ({ username: u.username, displayName: u.display_name, mustChange: u.must_change === 1 });
