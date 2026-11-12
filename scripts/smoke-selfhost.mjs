// End-to-end smoke test of the self-hosted server (dist/server.mjs) with the fake LINE client and a test clock.
//   npm run smoke            (builds dist/server.mjs first)
// Starts the server on a temporary database, then: break-glass admin login -> members with emails -> location ->
// roster import -> scheduler (reminder, prompt, missed) -> GPS check-in -> dashboard. The Google step is simulated
// by writing line_user_id directly (it needs a real Google account).
import { spawn } from "node:child_process";
import { createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";

/** Minimal SMTP receiver (no TLS) so the real nodemailer path is exercised. Collects {to, data}. */
const mails = [];
const smtp = createServer((sock) => {
  let rcpt = [], inData = false, buf = "", data = "";
  sock.write("220 smoke ESMTP\r\n");
  sock.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\r\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (inData) {
        if (line === ".") { inData = false; mails.push({ to: rcpt, data }); rcpt = []; data = ""; sock.write("250 queued\r\n"); }
        else data += line + "\n";
        continue;
      }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === "EHLO") sock.write("250-smoke\r\n250 8BITMIME\r\n");
      else if (cmd === "RCPT") { rcpt.push(/<(.*)>/.exec(line)?.[1]); sock.write("250 ok\r\n"); }
      else if (cmd === "DATA") { inData = true; sock.write("354 go\r\n"); }
      else if (cmd === "QUIT") { sock.end("221 bye\r\n"); }
      else sock.write("250 ok\r\n");
    }
  });
});
await new Promise((r) => smtp.listen(0, "127.0.0.1", r));

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "sdn-smoke-"));
const proc = spawn(process.execPath, ["dist/server.mjs"], {
  env: {
    ...process.env, PORT: String(PORT), DATA_DIR: dir, PUBLIC_URL: BASE, LINE_CLIENT: "fake", LIFF_ID: "smoke-liff",
    ALLOW_TEST_CLOCK: "1", ADMIN_TOKEN: "smoke-token", ALLOW_PASSWORD_LOGIN: "1", BACKUP_KEEP: "0",
    INITIAL_ADMIN_EMAILS: "first.admin@example.ac.th", GOOGLE_ALLOWED_DOMAINS: "example.ac.th",
    SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtp.address().port), SMTP_SECURE: "0", SMTP_REQUIRE_TLS: "0", SMTP_FROM: "SK Duty <duty@example.ac.th>",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
proc.stdout.on("data", (d) => (log += d));
proc.stderr.on("data", (d) => (log += d));

let failures = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${extra}`}`); if (!ok) failures++; };

/** Bangkok wall clock (UTC+7) -> epoch ms. */
const bkk = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+07:00`);
const D = "2030-03-04";
let cookie = "";
async function call(method, path, body, now) {
  const headers = { "content-type": "application/json", origin: BASE };
  if (cookie) headers.cookie = cookie;
  if (now) headers["x-test-now"] = String(now);
  if (path.startsWith("/dev/")) headers.authorization = "Bearer smoke-token";
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, res };
}

try {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + "/healthz")).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  check("server is up", (await fetch(BASE + "/healthz")).ok, log);

  // Break-glass admin (same hash format as scripts/create-admin.mjs), written straight into SQLite.
  const sqlite = new DatabaseSync(join(dir, "sk-duty-notify.sqlite"));
  const salt = randomBytes(16);
  const hash = `pbkdf2-sha256$1000$${salt.toString("base64")}$${pbkdf2Sync("smoke-password-123", salt, 1000, 32, "sha256").toString("base64")}`;
  sqlite.prepare("INSERT INTO admin_users (username, display_name, password_hash, must_change, created_at) VALUES ('ops', 'Ops', ?, 0, 0)").run(hash);
  check("initial admin from INITIAL_ADMIN_EMAILS", !!sqlite.prepare("SELECT 1 FROM admin_users WHERE email = 'first.admin@example.ac.th'").get());

  const login = await call("POST", "/admin/api/login", { username: "ops", password: "smoke-password-123" });
  cookie = (login.res.headers.getSetCookie()[0] ?? "").split(";")[0];
  check("password login (break-glass)", login.status === 200 && cookie.startsWith("__Host-sdn_session="), JSON.stringify(login.data));

  const members = Array.from({ length: 3 }, (_, i) => ({ staffCode: `S00${i + 1}`, label: `Person ${i + 1}`, email: `p${i + 1}@example.ac.th` }));
  check("members upsert with emails", (await call("POST", "/admin/api/members", { members })).status === 200);
  check("email outside the allowed domain refused",
    (await call("POST", "/admin/api/members", { members: [{ staffCode: "S009", label: "X", email: "x@gmail.com" }] })).data.error === "invalid_member_email");
  // Simulate the Google step: members 1-3 linked to LINE users U001-U003, consent given.
  for (let i = 1; i <= 3; i++) sqlite.prepare("UPDATE members SET line_user_id = ?, linked_at = 0, consent_at = 0 WHERE staff_code = ?").run(`U00${i}`, `S00${i}`);

  const site = { lat: 13.75, lng: 100.5 };
  check("location saved", (await call("POST", "/admin/api/locations", { code: "GATE", name: "Gate", points: [{ ...site, radiusM: 100 }] })).status === 200);

  const rows = members.flatMap((m) => ["AM", "PM"].map((shift) => ({ date: D, staffCode: m.staffCode, locationCode: "GATE", shift })));
  const staged = await call("POST", "/admin/api/imports", { rows });
  check("roster staged", staged.status === 201, JSON.stringify(staged.data));
  const pub = await call("POST", `/admin/api/imports/${staged.data.batchId}/publish`);
  check("roster published (6 duties)", pub.status === 200 && pub.data.insert === 6, JSON.stringify(pub.data));

  // Email copies to everyone with a roster email.
  const settings = await call("GET", "/admin/api/settings");
  check("settings report email configured", settings.data.emailConfigured === true, JSON.stringify(settings.data).slice(0, 200));
  check("email mode saved", (await call("POST", "/admin/api/settings", { ...settings.data.schedule, emailMode: "all" })).status === 200);

  const tick = async (date, hhmm) => (await call("POST", "/dev/tick", undefined, bkk(date, hhmm))).data;
  const sent = async () => (await call("GET", "/dev/sent")).data.sent;
  await tick("2030-03-03", "15:59");
  await tick("2030-03-03", "16:00");
  check("3 reminders sent at 16:00 the day before", (await sent()) === 3, `sent=${await sent()}`);
  check("3 reminder emails over SMTP, Thai subject, portal link",
    mails.length === 3 && mails.every((m) => /^Subject: =\?UTF-8\?/m.test(m.data) && m.data.includes("Auto-Submitted: auto-generated")),
    JSON.stringify(mails.map((m) => m.to)));
  await tick(D, "06:30");
  check("3 AM prompts sent at 06:30", (await sent()) === 6, `sent=${await sent()}`);

  const now = bkk(D, "06:40");
  const start = await call("POST", "/api/checkin/start", { idToken: "tok:U001" }, now);
  check("check-in start gives a nonce", !!start.data.current?.nonce, JSON.stringify(start.data));
  const submit = await call("POST", "/api/checkin/submit",
    { idToken: "tok:U001", dutyId: start.data.current.dutyId, nonce: start.data.current.nonce, ...site, accuracy: 12 }, now);
  check("GPS check-in inside the geofence", submit.data.result === "ok", JSON.stringify(submit.data));
  const far = await call("POST", "/api/checkin/start", { idToken: "tok:U002" }, now);
  const outside = await call("POST", "/api/checkin/submit",
    { idToken: "tok:U002", dutyId: far.data.current.dutyId, nonce: far.data.current.nonce, lat: site.lat + 0.01, lng: site.lng, accuracy: 12 }, now);
  check("check-in 1.1 km away is refused", outside.data.result === "outside_geofence", JSON.stringify(outside.data));
  const replay = await call("POST", "/api/checkin/submit",
    { idToken: "tok:U001", dutyId: start.data.current.dutyId, nonce: start.data.current.nonce, ...site, accuracy: 12 }, now);
  check("replayed nonce is not a new check-in", replay.data.result !== "ok" || replay.data.reason === "already_checked_in", JSON.stringify(replay.data));

  // Let the background confirmation send finish: the test clock jumps 20 minutes next, which would make its lease look expired.
  await new Promise((r) => setTimeout(r, 1500));
  await tick(D, "06:41");
  await tick(D, "07:00");
  check("2 missed pushes, no LINE confirmation (8 total)", (await sent()) === 8, `sent=${await sent()}`);

  // Real clock here: the admin session was created at the real time, so a 2030 test clock would see it expired.
  const today = await call("GET", `/admin/api/today?date=${D}`);
  const am = (today.data.duties ?? []).filter((d) => d.shift === "AM");
  check("dashboard: 1 checked in, 2 still pending (AM)",
    am.filter((d) => d.status === "CHECKED_IN").length === 1 && am.filter((d) => d.status === "PENDING").length === 2, JSON.stringify(today.data).slice(0, 400));
  check("no failed outbox rows", !sqlite.prepare("SELECT 1 FROM outbox WHERE status = 'FAILED'").get(),
    JSON.stringify(sqlite.prepare("SELECT dedupe_key, last_error FROM outbox WHERE status = 'FAILED'").all()));
  const rc = sqlite.prepare("SELECT target_user_id, status, line_request_id FROM outbox WHERE kind = 'CONFIRM'").all();
  check("receipt emailed to the member who checked in", rc.length === 1 && rc[0].target_user_id === "p1@example.ac.th" && rc[0].status === "API_ACCEPTED"
    && mails.some((m) => m.data.includes(`Message-ID: ${rc[0].line_request_id}`)), JSON.stringify(rc));
  check("email rows accepted by SMTP (3 reminders, 3 prompts, 1 receipt, 2 missed)",
    sqlite.prepare("SELECT COUNT(*) AS n FROM outbox WHERE channel = 'email' AND status = 'API_ACCEPTED'").get().n === 9 && mails.length === 9,
    `mails=${mails.length} ${JSON.stringify(mails.map((m) => [m.to, /^Message-ID: (.*)$/mi.exec(m.data)?.[1], /^Subject: (.*)$/m.exec(m.data)?.[1]]))} ${JSON.stringify(sqlite.prepare("SELECT dedupe_key, status, attempts, last_error FROM outbox WHERE channel = 'email'").all())}`);

  // Member portal: a session for member 1 (the Google step needs a real account, so the session row is written directly).
  const memberToken = "smoke-member-session-token-0123456789";
  const m1 = sqlite.prepare("SELECT id FROM members WHERE staff_code = 'S001'").get();
  sqlite.prepare("INSERT INTO member_sessions (token_hash, member_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)")
    .run(createHash("sha256").update(memberToken).digest("hex"), m1.id, Date.now(), Date.now() + 86400000, Date.now());
  const saved = cookie;
  cookie = "";
  check("portal API needs a session", (await call("GET", "/me/api/me")).status === 401);
  cookie = `__Host-sdn_member=${memberToken}`;
  const recs = await call("GET", `/me/api/records?from=${D}&to=${D}`);
  check("portal shows own duties with the check-in", recs.status === 200 && recs.data.totals.checkedIn === 1 && recs.data.duties.length === 2, JSON.stringify(recs.data).slice(0, 300));
  cookie = saved;

  for (const p of ["/me", "/credits", "/brand/logo.svg", "/brand/thanakorn-wordmark.svg", "/sheet"]) {
    const r = await fetch(BASE + p);
    check(`GET ${p}`, r.status === 200, String(r.status));
  }
  const health = await (await fetch(BASE + "/healthz")).json();
  check("healthz reports the version", typeof health.version === "string", JSON.stringify(health));
  sqlite.close();
} catch (e) {
  failures++;
  console.error(e);
} finally {
  proc.kill("SIGTERM");
  await new Promise((r) => proc.on("exit", r));
  rmSync(dir, { recursive: true, force: true }); // the mkdtemp directory created above
  smtp.close();
}
if (failures) {
  console.log(`\n${failures} check(s) failed. Server log:\n${log}`);
  process.exit(1);
}
console.log("\nall checks passed");
