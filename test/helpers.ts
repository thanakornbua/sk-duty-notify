import { env } from "cloudflare:workers";
import { handleRequest } from "../src/app";
import { hashPassword } from "../src/auth";
import { applySchedule } from "../src/settings";
import type { Clock } from "../src/clock";
import { FixedClock } from "../src/clock";
import { publishImport, stageImport, type RosterRow } from "../src/importer";
import { FakeLineClient, fakeIdToken } from "../src/line-fake";
import { bangkokInstant, MIN } from "../src/time";
import { sha256Hex } from "../src/util";

export { MIN };
export const db = env.DB;
export const TABLES = ["settings", "admin_sessions", "admin_users", "audit_log", "webhook_events", "scheduler_heartbeat", "outbox", "checkins", "nonces", "duties", "roster_dates",
  "import_batches", "geofence_points", "locations", "link_codes", "members"];
export const D = "2026-03-02"; // default duty date (a Monday)
export const LIFF = "test-liff";

/** Synthetic site: roughly central Bangkok. 0.001 deg latitude is about 111 m. */
export const SITE = { lat: 13.75, lng: 100.5 };

export const at = (date: string, hhmm: string, dayOffset = 0) => bangkokInstant(date, hhmm, dayOffset);
export const sc = (n: number) => `S${String(n).padStart(3, "0")}`;
export const uid = (n: number) => `U${String(n).padStart(3, "0")}`;
export const token = (n: number) => fakeIdToken(uid(n));

/** Test admin. Low iteration count keeps tests fast; production uses config.auth.pbkdf2Iterations. */
export const ADMIN = { username: "ops.admin", password: "test-password-123" };
const ADMIN_SESSION = "test-session-token";
let adminHash: Promise<string> | undefined;

/** Empty every table, then add one signed-in admin (session cookie ADMIN_SESSION, password already changed). */
export async function reset() {
  applySchedule({}); // back to config.ts defaults
  adminHash ??= hashPassword(ADMIN.password, 1000);
  await db.batch([
    ...TABLES.map((t) => db.prepare(`DELETE FROM ${t}`)),
    db.prepare("INSERT INTO admin_users (id, username, display_name, password_hash, must_change, created_at) VALUES (1, ?, 'Ops Admin', ?, 0, 0)")
      .bind(ADMIN.username, await adminHash),
    db.prepare("INSERT INTO admin_sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, 1, 0, 9e15, 9e15)")
      .bind(await sha256Hex(ADMIN_SESSION)),
  ]);
}

/** n members S001..; linked to U001.. unless listed in `unlinked`; consent given unless `noConsent`. */
export async function seedMembers(n: number, opts: { unlinked?: number[]; noConsent?: boolean } = {}) {
  await db.batch(Array.from({ length: n }, (_, k) => {
    const i = k + 1, linked = !opts.unlinked?.includes(i);
    return db.prepare("INSERT INTO members (id, staff_code, label, line_user_id, linked_at, consent_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 0)")
      .bind(i, sc(i), `Person ${i}`, linked ? uid(i) : null, linked ? 0 : null, opts.noConsent ? null : 0);
  }));
}

export async function seedLocation(code = "GATE", points = [{ ...SITE, radius_m: 100 }], accuracy = 50) {
  const loc = await db.prepare("INSERT INTO locations (code, name, allowed_accuracy_m) VALUES (?, ?, ?) RETURNING id")
    .bind(code, `Site ${code}`, accuracy).first<{ id: number }>();
  if (points.length) await db.batch(points.map((p) => db.prepare("INSERT INTO geofence_points (location_id, lat, lng, radius_m) VALUES (?, ?, ?, ?)")
    .bind(loc!.id, p.lat, p.lng, p.radius_m)));
  return loc!.id;
}

export async function publishRows(rows: RosterRow[], clock: Clock = new FixedClock(at(D, "08:00", -7))) {
  const staged = await stageImport(db, clock, { rows });
  if (!staged.ok) throw new Error(staged.errors.join("; "));
  const pub = await publishImport(db, clock, staged.value.batchId);
  if (!pub.ok) throw new Error(pub.errors.join("; "));
  return pub.value;
}

/** Members 1..n on AM and PM at GATE on each date. */
export const amPm = (dates: string[], n: number, location = "GATE"): RosterRow[] =>
  dates.flatMap((date) => Array.from({ length: n }, (_, k) => ["AM", "PM"].map((shift) => ({ date, staffCode: sc(k + 1), locationCode: location, shift })))).flat();

/** Standard world: 10 linked members, one site, AM+PM on D. */
export async function standardDay(opts: { unlinked?: number[]; noConsent?: boolean } = {}) {
  await reset();
  await seedMembers(10, opts);
  await seedLocation();
  await publishRows(amPm([D], 10));
}

export function call(line: FakeLineClient, clock: Clock, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const req = new Request(`https://x.test${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return handleWithBackground(req, clock, line);
}

/** Runs the request, then awaits anything it scheduled with waitUntil (e.g. the check-in confirmation push). */
async function handleWithBackground(req: Request, clock: Clock, line: FakeLineClient) {
  const background: Promise<unknown>[] = [];
  const res = await handleRequest(req, { ...env, LIFF_ID: LIFF }, clock, line, (p) => background.push(p));
  await Promise.all(background);
  return res;
}

/** Same-origin request with the test admin's session cookie. */
export const admin = (line: FakeLineClient, clock: Clock, method: string, path: string, body?: unknown) =>
  call(line, clock, method, path, body, { cookie: `__Host-sdn_session=${ADMIN_SESSION}`, origin: "https://x.test" });

export async function dutyId(member: number, shift = "AM", date = D) {
  const r = await db.prepare("SELECT d.id FROM duties d JOIN members m ON m.id = d.member_id WHERE m.staff_code = ? AND d.shift = ? AND d.duty_date = ? AND d.status != 'CANCELLED'")
    .bind(sc(member), shift, date).first<{ id: number }>();
  return r!.id;
}
