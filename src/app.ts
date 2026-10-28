import type { Clock } from "./clock";
import type { Env } from "./index";
import { buildDashboard } from "./dashboard";
import { buildPreview } from "./preview";
import { publishImport, stageImport } from "./importer";
import { config } from "./config";
import type { LineClient } from "./line";
import { FakeLineClient } from "./line-fake";
import { runScheduler } from "./scheduler";
import { handleWebhook, newBindingCode } from "./webhook";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** STUB admin auth for the prototype: a single shared bearer token. Replace before any real use. */
function adminAuthorized(req: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN) return false;
  return req.headers.get("authorization") === `Bearer ${env.ADMIN_TOKEN}`;
}

export async function handleRequest(req: Request, env: Env, clock: Clock, line?: LineClient): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "POST" && path === "/webhook/line") return handleWebhook(req, env, clock, line);

  // Dev/perf only: needs ALLOW_TEST_CLOCK=1 AND the admin token. Absent from any real deployment.
  if (path.startsWith("/dev/")) {
    if (env.ALLOW_TEST_CLOCK !== "1" || !adminAuthorized(req, env)) return json({ error: "not found" }, 404);
    if (req.method === "POST" && path === "/dev/tick") {
      return json(await runScheduler({ db: env.DB, clock, line, rand: () => 0.5 }));
    }
    if (req.method === "GET" && path === "/dev/sent" && line instanceof FakeLineClient) {
      return json({ sent: line.sent, replies: line.replies.length });
    }
    return json({ error: "not found" }, 404);
  }

  if (path.startsWith("/admin/")) {
    if (!adminAuthorized(req, env)) return json({ error: "unauthorized (stub admin token)" }, 401);

    if (req.method === "POST" && path === "/admin/people") {
      // Synthetic seeding helper: upsert [{staffId, label}].
      const body = (await req.json().catch(() => null)) as { people?: { staffId: string; label: string }[] } | null;
      if (!Array.isArray(body?.people)) return json({ error: "expected {people: [...]}" }, 400);
      await env.DB.batch(body.people.map((p) =>
        env.DB.prepare("INSERT INTO people (staff_id, label) VALUES (?, ?) ON CONFLICT (staff_id) DO UPDATE SET label = excluded.label")
          .bind(p.staffId, p.label)));
      return json({ ok: true, count: body.people.length });
    }

    if (req.method === "GET" && path === "/admin/dashboard.json") return json(await buildDashboard(env.DB, clock));
    if (req.method === "GET" && path === "/admin/preview.json") return json(await buildPreview(env.DB, clock));

    if (req.method === "POST" && path === "/admin/binding-codes") {
      const body = (await req.json().catch(() => null)) as { staffId?: string } | null;
      const person = typeof body?.staffId === "string"
        ? await env.DB.prepare("SELECT staff_id FROM people WHERE staff_id = ? AND active = 1").bind(body.staffId).first()
        : null;
      if (!person) return json({ error: "unknown or inactive staff id" }, 404);
      const now = clock.now();
      const code = newBindingCode();
      const expiresAt = now + config.bindingCodeTtlMinutes * 60_000;
      // A new code revokes any unused older one for the same staff ID.
      await env.DB.batch([
        env.DB.prepare("UPDATE binding_codes SET revoked_at = ? WHERE staff_id = ? AND used_at IS NULL AND revoked_at IS NULL").bind(now, body!.staffId),
        env.DB.prepare("INSERT INTO binding_codes (staff_id, code, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(body!.staffId, code, now, expiresAt),
        env.DB.prepare("INSERT INTO audit_log (at, actor, event, detail) VALUES (?, 'admin', 'binding_code_issued', ?)").bind(now, JSON.stringify({ staffId: body!.staffId })),
      ]);
      return json({ code, expiresAt }, 201);
    }

    if (req.method === "POST" && path === "/admin/imports") {
      const body = await req.json().catch(() => null);
      const res = await stageImport(env.DB, clock, body);
      return res.ok ? json({ ...res.value }, res.value.duplicate ? 200 : 201) : json({ errors: res.errors }, 422);
    }

    const m = /^\/admin\/imports\/(\d+)\/publish$/.exec(path);
    if (req.method === "POST" && m) {
      const res = await publishImport(env.DB, clock, Number(m[1]));
      return res.ok ? json(res.value) : json({ errors: res.errors }, res.status ?? 422);
    }
    return json({ error: "not found" }, 404);
  }

  return new Response("sk-duty-notify prototype", { status: 200 });
}
