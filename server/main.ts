/**
 * Self-hosted runtime: the same Worker (src/index.ts) on Node.js, for a machine behind a Cloudflare Tunnel.
 *   D1      -> SQLite file (server/d1.ts), migrations applied at start
 *   ASSETS  -> files in PUBLIC_DIR, served before the Worker like Cloudflare's assets
 *   cron    -> scheduled() at the start of every minute
 *   IP_LIMIT-> in-memory fixed window
 * Plus a daily online backup of the database. Configuration: environment variables (see .env.example).
 */
import { timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { config } from "../src/config";
import worker, { type Env } from "../src/index";
import { SqliteD1 } from "./d1";
import { smtpFromEnv } from "./smtp";

/* ------------------------------------------------------------------ config */
const ENV = process.env;
const PORT = Number(ENV.PORT ?? 8787);
const DATA_DIR = resolve(ENV.DATA_DIR ?? "./data");
const PUBLIC_DIR = resolve(ENV.PUBLIC_DIR ?? "./public");
const MIGRATIONS_DIR = resolve(ENV.MIGRATIONS_DIR ?? "./migrations");
/** Public origin as members and Google see it, e.g. https://duty.example.ac.th. Used for request URLs and OAuth redirects. */
const PUBLIC_URL = (ENV.PUBLIC_URL ?? "").replace(/\/+$/, "");
const BACKUP_KEEP = Number(ENV.BACKUP_KEEP ?? 14);
const RATE = { limit: Number(ENV.RATE_LIMIT ?? 120), periodMs: Number(ENV.RATE_PERIOD_SECONDS ?? 60) * 1000 };
// No Workers subrequest/query caps here: send a whole wave (e.g. 150 prompts at 06:30) in one run.
config.batchSize = Number(ENV.SCHEDULER_BATCH_SIZE ?? 200);

if (!PUBLIC_URL) console.warn("PUBLIC_URL is not set: request URLs fall back to the Host header (Google sign-in needs the real public origin).");

// Workers has crypto.subtle.timingSafeEqual (non-standard); Node has it in node:crypto. Used by password login.
const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean };
subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(a as Uint8Array, b as Uint8Array);

/* ---------------------------------------------------------------- database */
mkdirSync(DATA_DIR, { recursive: true });
const db = new SqliteD1(join(DATA_DIR, "sk-duty-notify.sqlite"));
const applied = db.migrate(MIGRATIONS_DIR);
console.log(applied.length ? `migrations applied: ${applied.join(", ")}` : "database up to date");

// First admins: Google emails that must exist as management accounts (existing ones are left as they are).
for (const email of (ENV.INITIAL_ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)) {
  const r = db.sqlite.prepare(`INSERT INTO admin_users (username, email, display_name, password_hash, must_change, created_at)
    VALUES (?, ?, ?, '', 0, ?) ON CONFLICT DO NOTHING`).run(email, email, email, Date.now());
  if (r.changes) console.log(`initial admin added: ${email}`);
}

/* ------------------------------------------------------------------ assets */
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".csv": "text/csv; charset=utf-8", ".png": "image/png",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2", ".woff": "font/woff",
  ".map": "application/json", ".ts": "text/plain; charset=utf-8",
};

const fileAt = (rel: string): string | null => {
  const p = normalize(join(PUBLIC_DIR, rel));
  if (p !== PUBLIC_DIR && !p.startsWith(PUBLIC_DIR + sep)) return null; // no ../ escapes
  try { return statSync(p).isFile() ? p : null; } catch { return null; }
};

/**
 * Cloudflare's default html_handling ("auto-trailing-slash"): /sheet serves sheet.html, /sheet.html redirects to /sheet,
 * a directory with index.html is served at /dir/ (and /dir redirects there). Returns null when no file matches.
 */
async function serveAsset(req: Request): Promise<Response | null> {
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  const url = new URL(req.url);
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { return null; }
  const redirect = (to: string) => new Response(null, { status: 307, headers: { location: to + url.search } });

  if (path.endsWith(".html")) {
    const clean = path.endsWith("/index.html") ? path.slice(0, -"index.html".length) : path.slice(0, -".html".length);
    if (fileAt(path)) return redirect(clean);
  }
  let file: string | null = null;
  if (path.endsWith("/")) file = fileAt(join(path, "index.html"));
  else if (extname(path)) file = fileAt(path);
  else {
    file = fileAt(`${path}.html`);
    if (!file && fileAt(join(path, "index.html"))) return redirect(`${path}/`);
  }
  if (!file) return null;

  const st = statSync(file);
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  const headers = {
    "content-type": type, etag,
    "cache-control": type.startsWith("text/html") ? "no-cache" : file.includes(`${sep}vendor${sep}`) ? "public, max-age=86400" : "public, max-age=0, must-revalidate",
  };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(req.method === "HEAD" ? null : await readFile(file), { headers });
}

/* ------------------------------------------------------------- rate limit */
const windows = new Map<string, { start: number; count: number }>();
const IP_LIMIT = {
  async limit({ key }: { key: string }) {
    const now = Date.now();
    const w = windows.get(key);
    if (!w || now - w.start >= RATE.periodMs) { windows.set(key, { start: now, count: 1 }); return { success: true }; }
    w.count++;
    return { success: w.count <= RATE.limit };
  },
};
setInterval(() => {
  const now = Date.now();
  for (const [k, w] of windows) if (now - w.start >= RATE.periodMs) windows.delete(k);
}, 60_000).unref();

/* -------------------------------------------------------------------- env */
const str = (k: string) => (ENV[k] ? ENV[k] : undefined);
const env: Env = {
  DB: db as unknown as D1Database,
  ASSETS: { fetch: async (req: Request) => (await serveAsset(req)) ?? new Response("not found", { status: 404 }) } as unknown as Fetcher,
  IP_LIMIT: IP_LIMIT as unknown as RateLimit,
  LINE_CHANNEL_SECRET: str("LINE_CHANNEL_SECRET"),
  LINE_CHANNEL_ACCESS_TOKEN: str("LINE_CHANNEL_ACCESS_TOKEN"),
  LINE_LOGIN_CHANNEL_ID: str("LINE_LOGIN_CHANNEL_ID"),
  LIFF_ID: str("LIFF_ID"),
  GOOGLE_CLIENT_ID: str("GOOGLE_CLIENT_ID"),
  GOOGLE_CLIENT_SECRET: str("GOOGLE_CLIENT_SECRET"),
  GOOGLE_ALLOWED_DOMAINS: str("GOOGLE_ALLOWED_DOMAINS"),
  ALLOW_PASSWORD_LOGIN: str("ALLOW_PASSWORD_LOGIN"),
  ADMIN_TOKEN: str("ADMIN_TOKEN"),
  LINE_CLIENT: str("LINE_CLIENT"),
  ALLOW_TEST_CLOCK: str("ALLOW_TEST_CLOCK"),
  PUBLIC_URL: PUBLIC_URL || undefined,
  EMAIL: smtpFromEnv(ENV),
  EMAIL_CLIENT: str("EMAIL_CLIENT"),
};
console.log(env.EMAIL ? `email: SMTP via ${ENV.SMTP_HOST}` : "email: not configured (SMTP_HOST unset)");

const background = new Set<Promise<unknown>>();
const ctx = {
  waitUntil(p: Promise<unknown>) {
    const q = p.catch((e) => console.error("background task failed", e)).finally(() => background.delete(q));
    background.add(q);
  },
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

/* ------------------------------------------------------------------- http */
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
};

async function toRequest(req: IncomingMessage): Promise<Request> {
  const origin = PUBLIC_URL || `${req.headers["x-forwarded-proto"] ?? "http"}://${req.headers.host ?? "localhost"}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
  }
  // cloudflared forwards the visitor's IP as Cf-Connecting-Ip. Without the tunnel (local runs), use the socket address.
  if (!headers.has("cf-connecting-ip") && req.socket.remoteAddress) headers.set("cf-connecting-ip", req.socket.remoteAddress);
  let body: Buffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 10 * 1024 * 1024) throw new Error("body too large");
      chunks.push(c as Buffer);
    }
    body = Buffer.concat(chunks);
  }
  return new Request(origin + (req.url ?? "/"), { method: req.method, headers, body });
}

async function send(res: ServerResponse, r: Response) {
  const out: Record<string, string | string[]> = { ...SECURITY_HEADERS };
  r.headers.forEach((v, k) => { if (k !== "set-cookie") out[k] = v; });
  const cookies = r.headers.getSetCookie();
  if (cookies.length) out["set-cookie"] = cookies;
  res.writeHead(r.status, out);
  res.end(r.body ? Buffer.from(await r.arrayBuffer()) : undefined);
}

const server = createServer(async (req, res) => {
  try {
    const request = await toRequest(req);
    const response = (await serveAsset(request)) ?? (await worker.fetch(request as never, env, ctx));
    await send(res, response);
  } catch (e) {
    console.error("request failed", req.method, req.url, e);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "internal" }));
  }
});

/* ------------------------------------------------------------------- cron */
let running = false;
async function tick() {
  if (running) return; // a slow run never overlaps the next one (outbox leases also protect against this)
  running = true;
  try {
    await worker.scheduled({ cron: "* * * * *", scheduledTime: Date.now(), type: "scheduled", noRetry() {} } as never, env);
  } catch (e) {
    console.error("scheduler run failed", e);
  } finally {
    running = false;
  }
}
let cronTimer: NodeJS.Timeout;
function scheduleNextTick() {
  const delay = 60_000 - (Date.now() % 60_000) + 50;
  cronTimer = setTimeout(() => { scheduleNextTick(); void tick(); }, delay);
}

/* ----------------------------------------------------------------- backup */
const BACKUP_DIR = join(DATA_DIR, "backups");
function dailyBackup() {
  try {
    mkdirSync(BACKUP_DIR, { recursive: true });
    const day = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10); // Bangkok date
    const file = join(BACKUP_DIR, `sk-duty-notify-${day}.sqlite`);
    if (!existsSync(file)) {
      db.backup(file);
      console.log(`backup written: ${file}`);
    }
    const old = readdirSync(BACKUP_DIR).filter((f) => /^sk-duty-notify-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort().slice(0, -BACKUP_KEEP);
    for (const f of old) rmSync(join(BACKUP_DIR, f));
  } catch (e) {
    console.error("backup failed", e);
  }
}
const backupTimer = BACKUP_KEEP > 0 ? setInterval(dailyBackup, 3600_000) : undefined;
if (BACKUP_KEEP > 0) dailyBackup();

/* ------------------------------------------------------------------ start */
server.listen(PORT, () => {
  console.log(`sk-duty-notify listening on :${PORT} (public URL ${PUBLIC_URL || "from Host header"})`);
  scheduleNextTick();
});

async function shutdown(signal: string) {
  console.log(`${signal}: shutting down`);
  clearTimeout(cronTimer);
  if (backupTimer) clearInterval(backupTimer);
  server.close();
  const deadline = Date.now() + 10_000;
  while ((running || background.size) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  db.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
