import { env } from "cloudflare:workers";
import { describe, it, expect, beforeEach } from "vitest";
import { handleRequest } from "../src/app";
import { FixedClock } from "../src/clock";
import { config } from "../src/config";
import { buildMessages } from "../src/messages";
import { FakeLineClient } from "../src/line-fake";
import { runScheduler } from "../src/scheduler";
import previewHtml from "../public/preview.html?raw";
import { D, TABLES, at, db, seed } from "./helpers";

let clock: FixedClock;
beforeEach(async () => {
  for (const t of TABLES) await db.prepare(`DELETE FROM ${t}`).run();
  clock = new FixedClock(at(D, "09:00", -2));
});

const preview = async (token: string | null = "test-token") => {
  const r = await handleRequest(new Request("https://x.test/admin/preview.json", { headers: token ? { authorization: `Bearer ${token}` } : {} }), env, clock);
  return { status: r.status, body: r.status === 200 ? await r.json() as any : null };
};

describe("message preview", () => {
  it("needs the admin token", async () => {
    expect((await preview(null)).status).toBe(401);
  });

  it("uses a built-in sample when there is no upcoming roster", async () => {
    const { body } = await preview();
    expect(body.source).toContain("sample");
    expect(body.schedule.map((s: any) => s.kind)).toEqual(["ACK", "AM", "PM"]);
  });

  it("shows the real roster, send times and cutoffs from config (Bangkok, day before for ACK)", async () => {
    await seed([D]);
    const { body } = await preview();
    expect(body.dutyDate).toBe(D);
    expect(body.source).toBe("active roster");
    const [ack, am, pm] = body.schedule;
    expect(ack.sendAt).toBe(at(D, "16:00", -1));
    expect(am.sendAt).toBe(at(D, "06:30"));
    expect(pm.sendAt).toBe(at(D, "14:20"));
    expect(am.cutoffAt).toBe(at(D, "12:00"));
    expect(ack.messages[0].text).toContain("P1: Person 1");
    expect(ack.messages[0].text).toContain(D);
  });

  it("previews exactly what the scheduler pushes", async () => {
    await seed([D]);
    clock.set(at(D, "16:00", -1));
    const line = new FakeLineClient();
    await runScheduler({ db, clock, line, rand: () => 0.5 });
    const pushed = line.sent[0]; // ACK to the first person
    const act = await db.prepare(
      "SELECT s.id, s.revision FROM action_states s JOIN assignments a ON a.id=s.assignment_id WHERE a.staff_id='S001' AND s.action_kind='ACK'",
    ).first<any>();
    const roster = (await db.prepare("SELECT a.position, p.label FROM assignments a JOIN people p ON p.staff_id=a.staff_id WHERE a.duty_date=? ORDER BY a.position").bind(D).all<any>()).results;
    expect(pushed.messages).toEqual(buildMessages({ kind: "ACK", phase: "INITIAL", dutyDate: D, actionId: act.id, revision: act.revision, roster }));
  });

  it("every message fits LINE's limits for a buttons template", () => {
    const roster = config.positions.map((position, i) => ({ position, label: `Person ${i + 1}` }));
    for (const kind of ["ACK", "AM", "PM"] as const) for (const phase of ["INITIAL", "REMINDER"] as const) {
      for (const m of buildMessages({ kind, phase, dutyDate: "2026-03-01", actionId: 999999999, revision: 12, roster }) as any[]) {
        if (m.type === "text") { expect(m.text.length).toBeLessThanOrEqual(5000); continue; }
        expect(m.altText.length).toBeLessThanOrEqual(400);
        expect(m.template.text.length).toBeLessThanOrEqual(160); // limit without title or image
        expect(m.template.actions.length).toBeLessThanOrEqual(4);
        for (const a of m.template.actions) {
          expect(a.label.length).toBeLessThanOrEqual(20);
          expect(a.data.length).toBeLessThanOrEqual(300);
        }
      }
    }
  });

  it("the preview page is stub-labelled, mock-labelled, and uses no innerHTML or third-party scripts", () => {
    expect(previewHtml).toContain("STUB AUTH");
    expect(previewHtml).toContain("This is a mock");
    expect(previewHtml).not.toContain("innerHTML");
    expect(previewHtml).not.toMatch(/<script[^>]+src=["']https?:/);
  });
});

describe("roster order", () => {
  it("lists positions in config order (P2 before P10), in the message and on the dashboard", async () => {
    await seed([D]);
    const { body } = await preview();
    const text: string = body.schedule[0].messages[0].text;
    expect(text.indexOf("P2:")).toBeLessThan(text.indexOf("P10:"));
    expect(text.split("\n").slice(1, 11).map((l) => l.split(":")[0])).toEqual(config.positions);

    clock.set(at(D, "09:00"));
    const r = await handleRequest(new Request("https://x.test/admin/dashboard.json", { headers: { authorization: "Bearer test-token" } }), env, clock);
    const d = await r.json() as any;
    expect(d.days[0].rows.map((x: any) => x.position)).toEqual(config.positions);
  });
});
