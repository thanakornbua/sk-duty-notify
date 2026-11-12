import { devAuthorized, handleAdmin } from "./admin";
import { identify, logUnidentified, recordConsent, startCheckin, submitCheckin } from "./checkin";
import type { Clock } from "./clock";
import { config } from "./config";
import { emailClientFor } from "./email";
import type { Env } from "./index";
import type { LineClient } from "./line";
import { FakeLineClient } from "./line-fake";
import { adminStart, callback, googleConfigured, portalStart, startGoogle } from "./google";
import { handlePortal } from "./portal";
import { runScheduler, sendNow } from "./scheduler";
import { json, readJson, sha256Hex } from "./util";
import { handleWebhook } from "./webhook";

/** `waitUntil` runs work after the response (the Worker's ctx.waitUntil); tests may omit it. */
export type WaitUntil = (p: Promise<unknown>) => void;

export async function handleRequest(req: Request, env: Env, clock: Clock, line?: LineClient, waitUntil?: WaitUntil): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "POST" && path === "/webhook/line") return handleWebhook(req, env, clock, line);
  if (path.startsWith("/api/")) return handleMemberApi(req, env, clock, line, path, waitUntil);
  if (req.method === "GET" && path === "/auth/google/admin") return adminStart(req, env, clock);
  if (req.method === "GET" && path === "/auth/google/member") return portalStart(req, env, clock);
  if (path.startsWith("/me/api/")) return handlePortal(req, env, clock, path, url, await ipHashOf(req), line, waitUntil);
  if (req.method === "GET" && path === "/auth/google/callback") return callback(req, env, clock, { ipHash: await ipHashOf(req) });
  if (req.method === "GET" && path === "/healthz") return json({ ok: true, version: config.version });
  if (path.startsWith("/admin/api/")) return handleAdmin(req, env, clock, path, url, await ipHashOf(req), line, waitUntil);

  // Dev/perf only: needs ALLOW_TEST_CLOCK=1 AND the admin token. Absent from any real deployment.
  if (path.startsWith("/dev/")) {
    if (env.ALLOW_TEST_CLOCK !== "1" || !devAuthorized(req, env)) return json({ error: "not found" }, 404);
    if (req.method === "POST" && path === "/dev/tick") {
      return json(await runScheduler({
        db: env.DB, clock, line, liffId: env.LIFF_ID ?? "dev-liff", email: emailClientFor(env), publicUrl: env.PUBLIC_URL ?? url.origin, rand: () => 0.5,
      }));
    }
    if (req.method === "GET" && path === "/dev/sent" && line instanceof FakeLineClient) return json({ sent: line.sent.length });
    return json({ error: "not found" }, 404);
  }

  // Static pages (admin UI, LIFF pages) are served by the assets binding before the Worker runs.
  return env.ASSETS ? env.ASSETS.fetch(req) : new Response("not found", { status: 404 });
}

/** Send the check-in confirmation(s) right after the response; the scheduler retries any attempt that fails. */
export function sendConfirm(env: Env, clock: Clock, line: LineClient | undefined, keys: string[], waitUntil?: WaitUntil) {
  if (!waitUntil) return;
  const deps = { db: env.DB, clock, line, liffId: env.LIFF_ID, email: emailClientFor(env), publicUrl: env.PUBLIC_URL };
  waitUntil((async () => { for (const k of keys) await sendNow(deps, k); })().catch((e) => console.error("confirm send failed", e)));
}

async function ipHashOf(req: Request): Promise<string | null> {
  const ip = req.headers.get("cf-connecting-ip");
  return ip ? (await sha256Hex(`ip:${ip}`)).slice(0, 16) : null;
}

/** Endpoints called from the LIFF pages. Identity always comes from a LINE-verified ID token. */
async function handleMemberApi(req: Request, env: Env, clock: Clock, line: LineClient | undefined, path: string, waitUntil?: WaitUntil): Promise<Response> {
  if (req.method === "GET" && path === "/api/liff-config") {
    return env.LIFF_ID ? json({ liffId: env.LIFF_ID }) : json({ error: "LIFF not configured" }, 503);
  }
  if (req.method !== "POST") return json({ error: "not found" }, 404);
  if (!line) return json({ error: "LINE not configured" }, 503);

  const ipHash = await ipHashOf(req);
  // Before any LINE call: per-IP limit (Workers rate-limit binding, if configured).
  if (env.IP_LIMIT && ipHash && !(await env.IP_LIMIT.limit({ key: ipHash })).success) {
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

  // Linking: any LINE-verified user may start Google sign-in ("not_linked" is the expected case here).
  if (path === "/api/google/link-start" || path === "/api/status") {
    if (!who.userId) return json({ error: "invalid_token" }, 401);
    if (path === "/api/status") return json(who.ok ? { linked: true, label: who.member.label, staffCode: who.member.staff_code } : { linked: false });
    if (!googleConfigured(env)) return json({ error: "google_not_configured" }, 503);
    const { url } = await startGoogle(env.DB, clock, env, new URL(req.url).origin, "member", { lineUserId: who.userId });
    return json({ url });
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
      const { status, confirmKeys, ...rest } = out;
      if (confirmKeys) sendConfirm(env, clock, line, confirmKeys, waitUntil);
      return json({ ...rest, confirmQueued: !!confirmKeys }, status);
    }
  }
  return json({ error: "not found" }, 404);
}
