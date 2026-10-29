// Perf probe: 150 members, 150 LIFF linkings, one 10-person AM+PM duty day, FakeLineClient. Synthetic data only.
//   npm run perf
// Starts `wrangler dev --local`, drives it over HTTP with a controllable clock (x-test-now), and reads the
// CPU time workerd itself used around each request from /proc/<pid>/task/*/schedstat (ns, summed over threads).
//
// What this number is: CPU of the whole local workerd process for one request, INCLUDING the local SQLite
// that backs D1 and runtime overhead. In production D1 runs remotely and the ID-token verify is a subrequest
// (wall time, not CPU), so the Worker's own CPU should be lower. Treat it as an upper-bound proxy.
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync } from "node:fs";

const PORT = 8799, BASE = `http://127.0.0.1:${PORT}`, PERSIST = ".wrangler/perf-state";
const TOKEN = "perf-admin-token";
const D = "2026-03-02";
const MIN = 60_000, TZ = 7 * 60 * MIN;
const bkk = (date, hhmm, dayOffset = 0) => {
  const [y, m, d] = date.split("-").map(Number), [h, mi] = hhmm.split(":").map(Number);
  return Date.UTC(y, m - 1, d + dayOffset, h, mi) - TZ;
};
const sc = (n) => `S${String(n).padStart(3, "0")}`;
const SITE = { lat: 13.75, lng: 100.5 };

/* ------------------------------------------------------------ cpu probe */
let procs = [];
function findWorkerd(rootPid) {
  const ppid = new Map(), comm = new Map();
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = readFileSync(`/proc/${d}/stat`, "utf8");
      comm.set(+d, st.slice(st.indexOf("(") + 1, st.lastIndexOf(")")));
      ppid.set(+d, +st.slice(st.lastIndexOf(")") + 2).split(" ")[1]);
    } catch { /* process vanished */ }
  }
  const out = [];
  for (const [pid, name] of comm) {
    if (!/workerd/.test(name)) continue;
    for (let p = pid; p && p !== 1; p = ppid.get(p)) if (p === rootPid) { out.push(pid); break; }
  }
  return out;
}
function cpuNs() {
  let total = 0;
  for (const pid of procs) {
    try {
      for (const t of readdirSync(`/proc/${pid}/task`)) total += Number(readFileSync(`/proc/${pid}/task/${t}/schedstat`, "utf8").split(" ")[0]);
    } catch { /* thread exited */ }
  }
  return total;
}
const stats = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), q = (p) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
  const r = (x) => Math.round(x * 100) / 100;
  return { n: s.length, p50: r(q(0.5)), p95: r(q(0.95)), max: r(s.at(-1)) };
};

/* --------------------------------------------------------------- http */
let ipN = 0;
async function http(method, path, { body, headers = {}, now } = {}) {
  const res = await fetch(BASE + path, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    // A distinct client IP per request keeps the per-IP limiter out of the measurement.
    headers: { "content-type": "application/json", "cf-connecting-ip": `10.0.${(ipN >> 8) & 255}.${ipN++ & 255}`,
      ...(now ? { "x-test-now": String(now) } : {}), ...headers },
  });
  const txt = await res.text();
  let json; try { json = JSON.parse(txt); } catch { /* plain text */ }
  return { status: res.status, json, txt };
}
// Admin calls use a real login session (cookie + same-origin header), like the admin pages.
let session = "";
const admin = (method, path, body, now) => http(method, path, { body, headers: { cookie: session, origin: BASE }, now });
async function measured(bucket, fn) {
  const before = cpuNs();
  const r = await fn();
  bucket.push((cpuNs() - before) / 1e6);
  return r;
}
const must = (r, what) => { if (r.status >= 300 && r.status !== 422) throw new Error(`${what}: ${r.status} ${r.txt}`); return r; };

/* ---------------------------------------------------------------- main */
rmSync(PERSIST, { recursive: true, force: true });
execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", PERSIST], { stdio: "ignore" });
const boot = JSON.parse(execFileSync("node", ["scripts/create-admin.mjs", "perf.admin", "Perf Admin"], { encoding: "utf8" }));
execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--persist-to", PERSIST, "--command", boot.sql], { stdio: "ignore" });
const dev = spawn("npx", ["wrangler", "dev", "--local", "--port", String(PORT), "--persist-to", PERSIST,
  "--var", `ADMIN_TOKEN:${TOKEN}`, "--var", "LINE_CLIENT:fake", "--var", "ALLOW_TEST_CLOCK:1", "--var", "LIFF_ID:perf-liff"],
  { stdio: "ignore", detached: true });
const stop = () => { try { process.kill(-dev.pid, "SIGTERM"); } catch { /* gone */ } };
process.on("exit", stop);

try {
  for (let i = 0; ; i++) {
    try { if ((await http("GET", "/api/liff-config")).status === 200) break; } catch { /* not up yet */ }
    if (i > 120) throw new Error("wrangler dev did not start");
    await new Promise((r) => setTimeout(r, 500));
  }
  procs = findWorkerd(dev.pid);
  if (!procs.length) throw new Error("could not find workerd processes to measure");

  const trivial = [];
  for (let i = 0; i < 50; i++) await measured(trivial, () => http("GET", "/api/liff-config"));

  // Setup (unmeasured): sign in, 150 members, one site, 10 members on AM + PM.
  const t0 = bkk(D, "09:00", -2);
  const loginMs = [];
  const res = await measured(loginMs, () => fetch(`${BASE}/admin/api/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ username: "perf.admin", password: boot.temporaryPassword }) }));
  session = (res.headers.get("set-cookie") ?? "").split(";")[0];
  must(await admin("POST", "/admin/api/password", { current: boot.temporaryPassword, next: "perf run passphrase 2026" }, t0), "password");
  must(await admin("POST", "/admin/api/members", { members: Array.from({ length: 150 }, (_, i) => ({ staffCode: sc(i + 1), label: `Person ${i + 1}` })) }, t0), "members");
  must(await admin("POST", "/admin/api/locations", { code: "GATE", name: "Main gate", points: [{ ...SITE, radiusM: 100 }] }, t0), "location");
  const rows = Array.from({ length: 10 }, (_, i) => ["AM", "PM"].map((shift) => ({ date: D, staffCode: sc(i + 1), locationCode: "GATE", shift }))).flat();
  const staged = must(await admin("POST", "/admin/api/imports", { rows }, t0), "stage");
  must(await admin("POST", `/admin/api/imports/${staged.json.batchId}/publish`, undefined, t0), "publish");

  // 150 linkings through the LIFF endpoint (code issue unmeasured, link measured).
  const members = (await admin("GET", "/admin/api/members", undefined, t0)).json.members;
  const link = [];
  for (const m of members) {
    const { json } = await admin("POST", `/admin/api/members/${m.id}/link-code`, undefined, t0);
    const r = await measured(link, () => http("POST", "/api/link", { body: { idToken: `tok:U${m.staff_code}`, code: json.code }, now: t0 }));
    if (r.status !== 200) throw new Error("link failed: " + r.txt);
  }
  for (const m of members.slice(0, 10)) await http("POST", "/api/consent", { body: { idToken: `tok:U${m.staff_code}` }, now: t0 });

  // Scheduler every minute from 15:00 the day before to 19:00; members check in 10 min after each start.
  const tickBusy = [], tickIdle = [], start = [], ok = [], rejected = [];
  let sent = 0;
  const checkinAt = new Map([[bkk(D, "06:40"), "AM"], [bkk(D, "14:30"), "PM"]]);
  for (let now = bkk(D, "15:00", -1); now <= bkk(D, "19:00"); now += MIN) {
    if (checkinAt.has(now)) {
      for (let i = 1; i <= 10; i++) {
        const idToken = `tok:U${sc(i)}`;
        const s = await measured(start, () => http("POST", "/api/checkin/start", { body: { idToken }, now }));
        if (i <= 2) { // two members first try from too far away
          await measured(rejected, () => http("POST", "/api/checkin/submit", { body: { idToken, dutyId: s.json.current.dutyId, nonce: s.json.current.nonce, lat: SITE.lat + 0.01, lng: SITE.lng, accuracy: 10, clientTs: now }, now }));
          continue;
        }
        if (i > 8) continue; // two never check in, so the MISSED message fires
        const r = await measured(ok, () => http("POST", "/api/checkin/submit", { body: { idToken, dutyId: s.json.current.dutyId, nonce: s.json.current.nonce, lat: SITE.lat, lng: SITE.lng, accuracy: 12, clientTs: now }, now }));
        if (r.json?.result !== "ok") throw new Error("check-in failed: " + r.txt);
      }
    }
    const before = cpuNs();
    const res = await http("POST", "/dev/tick", { headers: { authorization: `Bearer ${TOKEN}` }, now });
    const cpu = (cpuNs() - before) / 1e6;
    if (res.status !== 200) throw new Error("tick failed: " + res.txt);
    (res.json.claimed ? tickBusy : tickIdle).push(cpu);
    sent += res.json.accepted;
  }
  const today = await measured([], () => admin("GET", `/admin/api/today?date=${D}`, undefined, bkk(D, "19:00")));

  console.log(JSON.stringify({
    note: "CPU ms of the local workerd process per request (upper-bound proxy incl. local SQLite). Target < 8 ms (Free tier 10 ms).",
    pushesAccepted: sent, expectedPushes: 10 + 20 + 4 + 4,
    dashboardCounts: today.json.counts,
    trivialRequest: stats(trivial),
    adminLogin: stats(loginMs),
    link: stats(link),
    checkinStart: stats(start),
    checkinSubmitOk: stats(ok),
    checkinSubmitRejected: stats(rejected),
    scheduledBusy: stats(tickBusy),
    scheduledIdle: stats(tickIdle),
  }, null, 2));
} finally {
  stop();
}
