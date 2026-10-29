import { adminAuthorized, handleAdmin } from "./admin";
import { identify, logUnidentified, recordConsent, startCheckin, submitCheckin } from "./checkin";
import type { Clock } from "./clock";
import type { Env } from "./index";
import type { LineClient } from "./line";
import { FakeLineClient } from "./line-fake";
import { linkWithCode } from "./linking";
import { runScheduler } from "./scheduler";
import { json, readJson, sha256Hex } from "./util";
import { handleWebhook } from "./webhook";

export async function handleRequest(req: Request, env: Env, clock: Clock, line?: LineClient): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "POST" && path === "/webhook/line") return handleWebhook(req, env, clock, line);
  if (path.startsWith("/api/")) return handleMemberApi(req, env, clock, line, path);
  if (path.startsWith("/admin/api/")) return handleAdmin(req, env, clock, path, url);

  // Dev/perf only: needs ALLOW_TEST_CLOCK=1 AND the admin token. Absent from any real deployment.
  if (path.startsWith("/dev/")) {
    if (env.ALLOW_TEST_CLOCK !== "1" || !adminAuthorized(req, env)) return json({ error: "not found" }, 404);
    if (req.method === "POST" && path === "/dev/tick") {
      return json(await runScheduler({ db: env.DB, clock, line, liffId: env.LIFF_ID ?? "dev-liff", rand: () => 0.5 }));
    }
    if (req.method === "GET" && path === "/dev/sent" && line instanceof FakeLineClient) return json({ sent: line.sent.length });
    return json({ error: "not found" }, 404);
  }

  // Static pages (admin UI, LIFF pages) are served by the assets binding before the Worker runs.
  return env.ASSETS ? env.ASSETS.fetch(req) : new Response("not found", { status: 404 });
}

/** Endpoints called from the LIFF pages. Identity always comes from a LINE-verified ID token. */
async function handleMemberApi(req: Request, env: Env, clock: Clock, line: LineClient | undefined, path: string): Promise<Response> {
  if (req.method === "GET" && path === "/api/liff-config") {
    return env.LIFF_ID ? json({ liffId: env.LIFF_ID }) : json({ error: "LIFF not configured" }, 503);
  }
  if (req.method !== "POST") return json({ error: "not found" }, 404);
  if (!line) return json({ error: "LINE not configured" }, 503);

  const ip = req.headers.get("cf-connecting-ip") ?? "";
  const ipHash = ip ? (await sha256Hex(`ip:${ip}`)).slice(0, 16) : null;
  // Before any LINE call: per-IP limit (Workers rate-limit binding, if configured).
  if (env.CHECKIN_IP_LIMIT && ipHash && !(await env.CHECKIN_IP_LIMIT.limit({ key: ipHash })).success) {
    return json({ error: "rate_limited" }, 429);
  }
  const body = await readJson(req);
  if (!body) return json({ error: "bad json" }, 400);
  const meta = { ipHash, userAgent: req.headers.get("user-agent") };

  let who: Awaited<ReturnType<typeof identify>>;
  try {
    who = await identify(env.DB, line, body.idToken);
  } catch {
    return json({ error: "line_unavailable" }, 503);
  }

  if (path === "/api/link") {
    if (!who.ok && who.error === "invalid_token") return json({ error: who.error }, 401);
    // Linking is for verified accounts that may not be linked yet ("not_linked" is the expected case here).
    const userId = who.userId;
    if (!userId) return json({ error: "invalid_token" }, 401);
    const res = await linkWithCode(env.DB, clock, userId, String(body.code ?? ""));
    return res.ok ? json(res) : json({ error: res.reason }, res.reason === "bad_code" ? 422 : 409);
  }

  if (path === "/api/checkin/submit" && !who.ok) {
    await logUnidentified(env.DB, clock, body, meta, who.error);
    return json({ result: "rejected", reason: who.error }, who.status);
  }
  if (!who.ok) return json({ error: who.error }, who.status);

  switch (path) {
    case "/api/checkin/start": return json(await startCheckin(env.DB, clock, who.member));
    case "/api/consent": await recordConsent(env.DB, clock, who.member); return json({ ok: true });
    case "/api/checkin/submit": {
      const out = await submitCheckin(env.DB, clock, who.member, body, meta);
      const { status, ...rest } = out;
      return json(rest, status);
    }
  }
  return json({ error: "not found" }, 404);
}
