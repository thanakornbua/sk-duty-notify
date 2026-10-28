import { env } from "cloudflare:workers";
import { describe, it, expect, beforeEach } from "vitest";
import { handleRequest } from "../src/app";
import { FixedClock } from "../src/clock";
import { config } from "../src/config";

const T = Date.UTC(2026, 2, 1);
const clock = new FixedClock(T);
const db = env.DB;
const TABLES = ["audit_log", "webhook_events", "notification_jobs", "action_states",
                "assignments", "roster_days", "roster_revisions", "people"];

const call = (method: string, path: string, body?: unknown, token: string | null = "test-token") =>
  handleRequest(new Request(`https://x.test${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, clock);

const staff = (n: number) => `S${String(n).padStart(3, "0")}`;
/** A full duty day: positions P1..P10 filled with staff starting at `from`. */
const day = (date: string, from = 1) => ({
  date,
  assignments: config.positions.map((position, i) => ({ position, staffId: staff(from + i) })),
});

async function counts() {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = (await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n;
  return out;
}

beforeEach(async () => {
  for (const t of TABLES) await db.prepare(`DELETE FROM ${t}`).run();
  const people = Array.from({ length: 30 }, (_, i) => ({ staffId: staff(i + 1), label: `Person ${i + 1}` }));
  expect((await call("POST", "/admin/people", { people })).status).toBe(200);
});

describe("import staging", () => {
  it("requires the admin token (stub)", async () => {
    expect((await call("POST", "/admin/imports", { days: [day("2026-03-01")] }, null)).status).toBe(401);
    expect((await call("POST", "/admin/imports", { days: [day("2026-03-01")] }, "wrong")).status).toBe(401);
  });

  it("stages a valid roster without activating it", async () => {
    const r = await call("POST", "/admin/imports", { days: [day("2026-03-01"), day("2026-03-02", 11), { date: "2026-03-03", assignments: [] }] });
    expect(r.status).toBe(201);
    const c = await counts();
    expect(c.roster_revisions).toBe(1);
    expect(c.roster_days).toBe(3);
    expect(c.assignments).toBe(20);
    const a = await db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE is_active = 1").first<{ n: number }>();
    expect(a!.n).toBe(0);
    const nd = await db.prepare("SELECT state FROM roster_days WHERE duty_date = '2026-03-03'").first<{ state: string }>();
    expect(nd!.state).toBe("NO_DUTY");
  });

  const bad: [string, unknown][] = [
    ["not an object", "hello"],
    ["no days", { days: [] }],
    ["bad date", { days: [{ date: "2026-02-31", assignments: [] }] }],
    ["duplicate dates", { days: [day("2026-03-01"), day("2026-03-01", 11)] }],
    ["unknown staff id", { days: [{ ...day("2026-03-01"), assignments: day("2026-03-01").assignments.map((a, i) => i === 0 ? { ...a, staffId: "S999" } : a) }] }],
    ["duplicate staff in a day", { days: [{ ...day("2026-03-01"), assignments: day("2026-03-01").assignments.map((a, i) => i === 1 ? { ...a, staffId: staff(1) } : a) }] }],
    ["position left empty", { days: [{ ...day("2026-03-01"), assignments: day("2026-03-01").assignments.slice(0, 9) }] }],
    ["unknown position", { days: [{ ...day("2026-03-01"), assignments: day("2026-03-01").assignments.map((a, i) => i === 0 ? { ...a, position: "PX" } : a) }] }],
    ["position filled twice", { days: [{ ...day("2026-03-01"), assignments: day("2026-03-01").assignments.map((a, i) => i === 1 ? { ...a, position: "P1" } : a) }] }],
    ["a good day plus a bad day", { days: [day("2026-03-01"), { date: "2026-03-02", assignments: day("2026-03-02").assignments.slice(0, 5) }] }],
  ];
  for (const [name, body] of bad) {
    it(`bad file leaves zero rows: ${name}`, async () => {
      const before = await counts();
      const r = await call("POST", "/admin/imports", body);
      expect(r.status).toBe(422);
      expect((await r.json() as { errors: string[] }).errors.length).toBeGreaterThan(0);
      expect(await counts()).toEqual(before);
    });
  }

  it("is a no-op when the same content is staged again (even if key order differs)", async () => {
    const body = { days: [day("2026-03-01")] };
    const first = await (await call("POST", "/admin/imports", body)).json() as { id: number; duplicate: boolean };
    expect(first.duplicate).toBe(false);
    const before = await counts();
    const reordered = { days: [{ assignments: [...body.days[0].assignments].reverse(), date: "2026-03-01" }] };
    const second = await call("POST", "/admin/imports", reordered);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ id: first.id, duplicate: true });
    expect(await counts()).toEqual(before);
  });
});

describe("publish", () => {
  const stage = async (body: unknown) => (await (await call("POST", "/admin/imports", body)).json() as { id: number }).id;
  const activeDates = async () =>
    (await db.prepare("SELECT DISTINCT duty_date FROM assignments WHERE is_active = 1 ORDER BY 1").all<{ duty_date: string }>()).results.map((r) => r.duty_date);

  it("activates atomically and supersedes the previous revision", async () => {
    const a = await stage({ days: [day("2026-03-01")] });
    expect((await call("POST", `/admin/imports/${a}/publish`)).status).toBe(200);
    expect(await activeDates()).toEqual(["2026-03-01"]);

    const b = await stage({ days: [day("2026-03-01", 11), day("2026-03-02")] });
    expect((await call("POST", `/admin/imports/${b}/publish`)).status).toBe(200);
    expect(await activeDates()).toEqual(["2026-03-01", "2026-03-02"]);
    const statuses = (await db.prepare("SELECT id, status FROM roster_revisions ORDER BY id").all<{ id: number; status: string }>()).results;
    expect(statuses).toEqual([{ id: a, status: "SUPERSEDED" }, { id: b, status: "ACTIVE" }]);
    const first = await db.prepare("SELECT staff_id FROM assignments WHERE is_active = 1 AND duty_date = '2026-03-01' AND position = 'P1'").first<{ staff_id: string }>();
    expect(first!.staff_id).toBe(staff(11));
  });

  it("publishing the active revision again is a no-op; a superseded one is refused", async () => {
    const a = await stage({ days: [day("2026-03-01")] });
    await call("POST", `/admin/imports/${a}/publish`);
    expect((await call("POST", `/admin/imports/${a}/publish`)).status).toBe(200);
    const b = await stage({ days: [day("2026-03-02")] });
    await call("POST", `/admin/imports/${b}/publish`);
    expect((await call("POST", `/admin/imports/${a}/publish`)).status).toBe(409);
    expect((await call("POST", `/admin/imports/9999/publish`)).status).toBe(404);
  });

  it("revalidates at publish: a staff member deactivated after staging blocks activation and changes nothing", async () => {
    const a = await stage({ days: [day("2026-03-01")] });
    await db.prepare("UPDATE people SET active = 0 WHERE staff_id = ?").bind(staff(3)).run();
    const r = await call("POST", `/admin/imports/${a}/publish`);
    expect(r.status).toBe(422);
    expect(await activeDates()).toEqual([]);
    const s = await db.prepare("SELECT status FROM roster_revisions WHERE id = ?").bind(a).first<{ status: string }>();
    expect(s!.status).toBe("STAGED");
  });
});
