import { adminByEmail, createSession, sessionCookie } from "./auth";
import type { Clock } from "./clock";
import { config } from "./config";
import type { Env } from "./index";
import { linkMemberByEmail } from "./linking";
import { createMemberSession, memberByEmail, memberCookie } from "./portal";
import { MIN } from "./time";
import { sha256Hex } from "./util";

/**
 * Google sign-in (OpenID Connect, authorization code + PKCE).
 *  - Members: the LIFF link page (inside LINE, identity = LINE ID token) starts it, then opens the phone's normal browser,
 *    because Google refuses sign-in inside in-app browsers. The callback links the LINE user to the member whose
 *    roster email matches the Google account.
 *  - Admins: /auth/google/admin -> Google -> callback -> session cookie. The state is also bound to the browser by a cookie.
 *  - Member portal: /auth/google/member -> Google -> callback -> member session cookie (same browser binding).
 * Only accounts on GOOGLE_ALLOWED_DOMAINS are accepted (Workspace `hd` claim AND the email's domain).
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
const STATE_COOKIE = "__Host-sdn_oauth";
/** Separate name for portal sign-ins, so a failure with no state row still lands on the right page. */
const PORTAL_STATE_COOKIE = "__Host-sdn_oauth_me";

/** Replaceable in tests. */
export const googleHttp = { fetch: (input: RequestInfo, init?: RequestInit) => fetch(input, init) };

export type GoogleError =
  | "google_not_configured" | "bad_state" | "cancelled" | "google_failed" | "email_not_verified" | "domain_not_allowed"
  | "not_on_roster" | "line_account_linked_elsewhere" | "not_an_admin";

type Purpose = "member" | "admin" | "portal";

export const googleConfigured = (env: Env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

export function allowedDomains(env: Env): string[] {
  return (env.GOOGLE_ALLOWED_DOMAINS ?? "").split(",").map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
}

const b64url = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const redirectUri = (origin: string) => `${origin}/auth/google/callback`;

/** Create a single-use state and return Google's authorization URL. */
export async function startGoogle(
  db: D1Database, clock: Clock, env: Env, origin: string, purpose: Purpose, opts: { lineUserId?: string; next?: string } = {},
): Promise<{ state: string; url: string }> {
  const now = clock.now();
  const state = randomToken(), verifier = randomToken();
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  await db.batch([
    db.prepare("DELETE FROM oauth_states WHERE expires_at <= ?").bind(now),
    db.prepare(`INSERT INTO oauth_states (state_hash, purpose, line_user_id, code_verifier, next_path, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(await sha256Hex(state), purpose, opts.lineUserId ?? null, verifier, opts.next ?? null, now, now + config.google.stateTtlMinutes * MIN),
  ]);
  const domains = allowedDomains(env);
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!, redirect_uri: redirectUri(origin), response_type: "code", scope: "openid email profile",
    state, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account",
  });
  // Account-chooser hint only; the domain is enforced on the callback.
  if (domains.length) q.set("hd", domains.length === 1 ? domains[0] : "*");
  return { state, url: `${AUTH_URL}?${q}` };
}

interface Claims { iss?: string; aud?: string; exp?: number; email?: string; email_verified?: boolean; hd?: string; name?: string }

function decodeIdToken(jwt: string): Claims | null {
  const part = jwt.split(".")[1];
  if (!part) return null;
  try {
    const bin = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}

/**
 * Exchange the code and check the identity. The ID token comes straight from Google's token endpoint over TLS,
 * authenticated with our client secret, so its signature need not be checked (OIDC Core 3.1.3.7); claims still are.
 */
async function exchange(env: Env, origin: string, code: string, verifier: string, now: number): Promise<{ ok: true; email: string; name: string } | { ok: false; error: GoogleError }> {
  let res: Response;
  try {
    res = await googleHttp.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, redirect_uri: redirectUri(origin),
        grant_type: "authorization_code", code_verifier: verifier,
      }),
    });
  } catch {
    return { ok: false, error: "google_failed" };
  }
  const body = (await res.json().catch(() => null)) as { id_token?: string } | null;
  const c = res.ok && body?.id_token ? decodeIdToken(body.id_token) : null;
  if (!c || !ISSUERS.includes(c.iss ?? "") || c.aud !== env.GOOGLE_CLIENT_ID || !c.exp || c.exp * 1000 < now || !c.email) {
    return { ok: false, error: "google_failed" };
  }
  if (c.email_verified !== true) return { ok: false, error: "email_not_verified" };
  const email = c.email.toLowerCase();
  const domains = allowedDomains(env);
  if (domains.length && (!domains.includes(email.split("@")[1]) || !domains.includes((c.hd ?? "").toLowerCase()))) {
    return { ok: false, error: "domain_not_allowed" };
  }
  return { ok: true, email, name: c.name ?? email };
}

export function stateCookie(state: string, name = STATE_COOKIE) {
  // Lax, not Strict: Google's redirect back to us is a cross-site top-level navigation.
  return `${name}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${config.google.stateTtlMinutes * 60}`;
}
const clearStateCookie = (name = STATE_COOKIE) => `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

function cookieValue(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=") || null;
  }
  return null;
}

const safeNext = (n: string | null | undefined) => (n && n.startsWith("/") && !n.startsWith("//") ? n : "/dashboard");

function redirect(location: string, cookies: string[] = []): Response {
  const h = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(null, { status: 303, headers: h });
}

/** GET /auth/google/admin?next=/path */
export async function adminStart(req: Request, env: Env, clock: Clock): Promise<Response> {
  const url = new URL(req.url);
  if (!googleConfigured(env)) return redirect("/login?error=google_not_configured");
  const { state, url: to } = await startGoogle(env.DB, clock, env, url.origin, "admin", { next: safeNext(url.searchParams.get("next")) });
  return redirect(to, [stateCookie(state)]);
}

/** GET /auth/google/member: member portal sign-in. */
export async function portalStart(req: Request, env: Env, clock: Clock): Promise<Response> {
  const url = new URL(req.url);
  if (!googleConfigured(env)) return redirect("/me?error=google_not_configured");
  const { state, url: to } = await startGoogle(env.DB, clock, env, url.origin, "portal", { next: "/me" });
  return redirect(to, [stateCookie(state, PORTAL_STATE_COOKIE)]);
}

/** GET /auth/google/callback?code&state (all purposes). */
export async function callback(req: Request, env: Env, clock: Clock, meta: { ipHash: string | null }): Promise<Response> {
  const url = new URL(req.url);
  const db = env.DB;
  const now = clock.now();
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  if (!googleConfigured(env)) return redirect("/login?error=google_not_configured");

  // Consume the state atomically: a replayed or expired state finds nothing.
  const row = state.length > 20 && state.length < 100 ? await db.prepare(
    `UPDATE oauth_states SET used_at = ?1 WHERE state_hash = ?2 AND used_at IS NULL AND expires_at > ?1
     RETURNING purpose, line_user_id, code_verifier, next_path`,
  ).bind(now, await sha256Hex(state)).first<{ purpose: Purpose; line_user_id: string | null; code_verifier: string; next_path: string | null }>() : null;

  const meta2 = { ipHash: meta.ipHash, userAgent: req.headers.get("user-agent") };
  const memberDone = (r: string, extra: Record<string, string> = {}, cookies: string[] = []) =>
    redirect(`/linked?${new URLSearchParams({ r, ...extra })}`, cookies);
  const adminFail = (e: GoogleError) => redirect(`/login?error=${e}`, [clearStateCookie()]);
  const portalFail = (e: GoogleError) => redirect(`/me?error=${e}`, [clearStateCookie(PORTAL_STATE_COOKIE)]);

  // Without a state row the purpose is unknown: the state cookie tells which page started it.
  if (!row) {
    if (cookieValue(req, PORTAL_STATE_COOKIE)) return portalFail("bad_state");
    return cookieValue(req, STATE_COOKIE) ? adminFail("bad_state") : memberDone("bad_state");
  }
  const fail = (e: GoogleError) => (row.purpose === "admin" ? adminFail(e) : row.purpose === "portal" ? portalFail(e) : memberDone(e));
  if (row.purpose === "admin" && cookieValue(req, STATE_COOKIE) !== state) return fail("bad_state");
  if (row.purpose === "portal" && cookieValue(req, PORTAL_STATE_COOKIE) !== state) return fail("bad_state");
  if (url.searchParams.get("error") || !code) return fail("cancelled");

  const who = await exchange(env, url.origin, code, row.code_verifier, now);
  if (!who.ok) return fail(who.error);

  if (row.purpose === "member") {
    const res = await linkMemberByEmail(db, clock, row.line_user_id!, who.email);
    if (!res.ok) return memberDone(res.reason);
    // Also signed in to the member portal in this browser.
    const m = await memberByEmail(db, who.email);
    const token = m ? await createMemberSession(db, clock, m.id, meta2) : null;
    return memberDone("ok", { name: res.label }, token ? [memberCookie(token)] : []);
  }

  if (row.purpose === "portal") {
    const m = await memberByEmail(db, who.email);
    if (!m) return portalFail("not_on_roster");
    const token = await createMemberSession(db, clock, m.id, meta2);
    return redirect("/me", [memberCookie(token), clearStateCookie(PORTAL_STATE_COOKIE)]);
  }

  const admin = await adminByEmail(db, who.email);
  if (!admin) {
    await db.prepare("INSERT INTO audit_log (at, actor, event, detail) VALUES (?, 'anonymous', 'google_login_refused', ?)")
      .bind(now, JSON.stringify({ email: who.email, ipHash: meta.ipHash })).run();
    return adminFail("not_an_admin");
  }
  const token = await createSession(db, clock, admin, { ipHash: meta.ipHash, userAgent: req.headers.get("user-agent") }, "login_google");
  // Land on a same-site page first, so the SameSite=Strict session cookie is sent on the next navigation.
  const next = safeNext(row.next_path);
  const h = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  h.append("set-cookie", sessionCookie(token));
  h.append("set-cookie", clearStateCookie());
  return new Response(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${next.replace(/[^A-Za-z0-9/_?=&.-]/g, "")}"><title>Signing in…</title>`, { headers: h });
}
