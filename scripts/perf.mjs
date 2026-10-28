// Perf probe: 150 staff, 150 bindings, one 10-person duty day, FakeLineClient. Synthetic data only.
//   node scripts/perf.mjs
// Starts `wrangler dev --local`, drives it over HTTP with a controllable clock (x-test-now), and reads the
// CPU time workerd itself used around each request from /proc/<pid>/task/*/schedstat (ns, summed over threads).
//
// What this number is: CPU of the whole local workerd process for one request, INCLUDING the local SQLite
// that backs D1 and runtime overhead. In production D1 runs remotely, so the Worker's own CPU should be
// lower than this. Treat it as an upper-bound proxy, not the billed figure.
import { spawn, execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync, readdirSync, rmSync } from "node:fs";

const PORT = 8799, BASE = `http://127.0.0.1:${PORT}`, PERSIST = ".wrangler/perf-state";
const SECRET = "perf-channel-secret", TOKEN = "perf-admin-token";
const DUTY = "2026-03-01";
const MIN = 60_000, TZ = 7 * 60 * MIN;
const bkk = (date, hhmm, dayOffset = 0) => {
  const [y, m, d] = date.split("-").map(Number), [h, mi] = hhmm.split(":").map(Number);
  return Date.UTC(y, m - 1, d + dayOffset, h, mi) - TZ;
};
const sid = (n) => `S${String(n).padStart(3, "0")}`;

/* ------------------------------------------------------------ cpu probe */
let procs = [];
function findWorkerd(rootPid) {
  const ppid = new Map(), comm = new Map();
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = readFileSync(`/proc/${d}/stat`, "utf8");
      const name = st.slice(st.indexOf("(") + 1, st.lastIndexOf(")"));
      ppid.set(+d, +st.slice(st.lastIndexOf(")") + 2).split(" ")[1]); comm.set(+d, name);
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
      for (const t of readdirSync(`/proc/${pid}/task`)) {
        total += Number(readFileSync(`/proc/${pid}/task/${t}/schedstat`, "utf8").split(" ")[0]);
      }
    } catch { /* thread exited */ }
  }
  return total;
}
const stats = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), q = (p) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: s.at(-1) };
};

/* --------------------------------------------------------------- http */
async function http(method, path, { body, headers = {}, now } = {}) {
  const res = await fetch(BASE + path, {
    method, body,
    headers: { "content-type": "application/json", ...(now ? { "x-test-now": String(now) } : {}), ...headers },
  });
  const txt = await res.text();
  let json; try { json = JSON.parse(txt); } catch { /* plain text */ }
  return { status: res.status, json, txt };
}
const admin = (method, path, obj, now) =>
  http(method, path, { body: obj ? JSON.stringify(obj) : undefined, headers: { authorization: `Bearer ${TOKEN}` }, now });

let evN = 0;
async function webhook(events, now, { sign = true } = {}) {
  const body = JSON.stringify({ destination: "Udest", events });
  const sig = sign ? createHmac("sha256", SECRET).update(body).digest("base64") : "AAAA";
  const before = cpuNs(), t0 = performance.now();
  const r = await http("POST", "/webhook/line", { body, headers: { "x-line-signature": sig }, now });
  return { status: r.status, cpuMs: (cpuNs() - before) / 1e6, wallMs: performance.now() - t0 };
}
const ev = (userId, extra) => ({ webhookEventId: `P${++evN}`, replyToken: `T${evN}`, source: { type: "user", userId }, ...extra });

/* ---------------------------------------------------------------- main */
rmSync(PERSIST, { recursive: true, force: true });
execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", PERSIST], { stdio: "ignore" });
const dev = spawn("npx", ["wrangler", "dev", "--local", "--port", String(PORT), "--persist-to", PERSIST,
  "--var", `ADMIN_TOKEN:${TOKEN}`, "--var", `LINE_CHANNEL_SECRET:${SECRET}`, "--var", "LINE_CLIENT:fake", "--var", "ALLOW_TEST_CLOCK:1"],
  { stdio: "ignore", detached: true });
const stop = () => { try { process.kill(-dev.pid, "SIGTERM"); } catch { /* gone */ } };
process.on("exit", stop);

try {
  for (let i = 0; ; i++) {
    try { if ((await http("GET", "/")).status === 200) break; } catch { /* not up yet */ }
    if (i > 120) throw new Error("wrangler dev did not start");
    await new Promise((r) => setTimeout(r, 500));
  }
  procs = findWorkerd(dev.pid);
  if (!procs.length) throw new Error("could not find workerd processes to measure");
  console.log(`measuring ${procs.length} workerd process(es)`);

  // Noise floor: CPU drift with no request in flight, and the cost of a trivial request.
  const idle = [];
  for (let i = 0; i < 20; i++) { const a = cpuNs(); await new Promise((r) => setTimeout(r, 50)); idle.push((cpuNs() - a) / 1e6); }
  const trivial = [];
  for (let i = 0; i < 50; i++) { const a = cpuNs(); await http("GET", "/"); trivial.push((cpuNs() - a) / 1e6); }

  // Setup (not measured): 150 staff, a 10-person duty day.
  const t0 = bkk(DUTY, "00:00", -2);
  await admin("POST", "/admin/people", { people: Array.from({ length: 150 }, (_, i) => ({ staffId: sid(i + 1), label: `Person ${i + 1}` })) }, t0);
  const positions = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
  const roster = { days: [{ date: DUTY, assignments: positions.map((position, i) => ({ position, staffId: sid(i + 1) })) }] };
  const staged = await admin("POST", "/admin/imports", roster, t0);
  const pub = await admin("POST", `/admin/imports/${staged.json.id}/publish`, null, t0);
  if (pub.status !== 200) throw new Error("publish failed: " + pub.txt);

  // 150 bindings, each: admin issues a code (unmeasured), user types it (measured).
  const bindMs = [];
  for (let i = 1; i <= 150; i++) {
    const { json } = await admin("POST", "/admin/binding-codes", { staffId: sid(i) }, t0);
    const r = await webhook([ev(`U${String(i).padStart(4, "0")}`, { type: "message", message: { type: "text", text: json.code } })], t0);
    if (r.status !== 200) throw new Error("bind failed");
    bindMs.push(r.cpuMs);
  }

  // Scheduler: every minute from 15:00 the evening before until 19:00 on the duty day.
  const tickAll = [], tickBusy = [], tickIdle = [];
  const post = { complete: [], dup: [], double: [], rejected: [], badSig: [] };
  const pending = []; // { at, userId, data }
  const seen = new Set();
  const start = bkk(DUTY, "15:00", -1), end = bkk(DUTY, "19:00");
  let sentCount = 0, firstDup = true;
  for (let now = start; now <= end; now += MIN) {
    // Users act: S001..S007 press 5 minutes after the push; S008..S010 never do (so reminders fire).
    while (pending.length && pending[0].at <= now) {
      const p = pending.shift();
      const e = ev(p.userId, { type: "postback", postback: { data: p.data } });
      const r = await webhook([e], now);
      post.complete.push(r.cpuMs);
      if (firstDup) { // replay the same event id once (dedupe) and tap again with a new id (double tap)
        post.dup.push((await webhook([e], now)).cpuMs);
        post.double.push((await webhook([ev(p.userId, { type: "postback", postback: { data: p.data } })], now)).cpuMs);
        post.rejected.push((await webhook([ev("Uother0000", { type: "postback", postback: { data: p.data } })], now)).cpuMs);
        post.badSig.push((await webhook([e], now, { sign: false })).cpuMs);
        firstDup = false;
      }
    }
    const before = cpuNs();
    const res = await admin("POST", "/dev/tick", null, now);
    const cpu = (cpuNs() - before) / 1e6;
    if (res.status !== 200) throw new Error("tick failed: " + res.txt);
    tickAll.push(cpu);
    const s = res.json;
    (s.claimed > 0 || s.planned > 0 || s.expired > 0 ? tickBusy : tickIdle).push(cpu);

    if (s.accepted > 0) { // learn the new pushes' buttons (unmeasured)
      const { json } = await admin("GET", "/dev/sent", null, now);
      for (const m of json.sent.slice(sentCount)) {
        sentCount = json.sent.length;
        const key = m.retryKey;
        if (seen.has(key)) continue;
        seen.add(key);
        const data = m.messages.at(-1)?.template?.actions?.[0]?.data;
        const n = Number(m.to.slice(1));
        if (data && n <= 7 && !/Remind/.test(JSON.stringify(m.messages))) pending.push({ at: now + 5 * MIN, userId: m.to, data });
      }
      pending.sort((a, b) => a.at - b.at);
    }
  }
  const final = (await admin("GET", "/dev/sent", null, end)).json;

  const f = (s) => (s ? `n=${String(s.n).padStart(4)}  p50=${s.p50.toFixed(2)}  p95=${s.p95.toFixed(2)}  max=${s.max.toFixed(2)}` : "n=0");
  console.log("\nCPU ms per request (local workerd, incl. local SQLite; see caveat in header)");
  console.log("  noise floor (50ms idle)  ", f(stats(idle)));
  console.log("  trivial GET /            ", f(stats(trivial)));
  console.log("  scheduler tick, all      ", f(stats(tickAll)));
  console.log("  scheduler tick, idle     ", f(stats(tickIdle)));
  console.log("  scheduler tick, busy     ", f(stats(tickBusy)));
  console.log("  webhook: bind (150)      ", f(stats(bindMs)));
  console.log("  webhook: postback ok     ", f(stats(post.complete)));
  console.log("  webhook: duplicate event ", f(stats(post.dup)));
  console.log("  webhook: double tap      ", f(stats(post.double)));
  console.log("  webhook: wrong user      ", f(stats(post.rejected)));
  console.log("  webhook: bad signature   ", f(stats(post.badSig)));
  console.log(`\nsimulated ${tickAll.length} minute-ticks, ${final.sent.length} pushes accepted, ${final.replies} webhook replies`);
  const worst = Math.max(stats(tickAll).p95, stats(bindMs).p95, stats(post.complete).p95);
  console.log(`target < 8 ms (Free tier): worst p95 here = ${worst.toFixed(2)} ms -> ${worst < 8 ? "under" : "OVER"} (upper-bound proxy)`);
} finally {
  stop();
}
