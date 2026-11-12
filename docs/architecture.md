# sk-duty-notify: Engineering Summary

> Architecture, structure, and mechanics of the system. For building a technical slide deck.

---

## 1. System overview

A duty-roster notification and check-in backend. It pushes scheduled LINE messages to individual members and verifies check-ins with a LIFF page (a web page running inside LINE) using the phone's GPS. Members link LINE to their roster entry by signing in with their school Google account.

One codebase (`src/`, written as a Cloudflare Worker) runs on two targets:

| Target | Database | Cron | Static files | Entrance |
|---|---|---|---|---|
| Cloudflare Workers | D1 | Workers cron trigger | assets binding | `*.workers.dev` or a custom domain |
| Self-hosted (Docker / k3s) | SQLite file via a D1-compatible adapter (`server/d1.ts`) | timer every minute | served by `server/main.ts` | Cloudflare Tunnel (`cloudflared`) |

No Redis or ORM. The self-hosted image is about 330 MB and uses about 100 MB of RAM.

## 2. Architecture

```
 Member phone (LINE app)                         Admin browser
 ┌──────────────────────────┐                   ┌──────────────────────────┐
 │ LINE chat ◀── pushes      │                   │ Admin web UI             │
 │ LIFF pages: link, checkin│                   │ (static HTML/JS)         │
 └────────────┬─────────────┘                   └────────────┬─────────────┘
              │ /api/*  (LINE ID token)                       │ /admin/api/* (session cookie)
              ▼                                               ▼
 ┌─────────────────────────────────────────────────────────────────────────┐
 │                    Cloudflare Worker  "sk-duty-notify"                  │
 │  fetch():     router → member API · admin API · LINE webhook · assets   │
 │  scheduled(): cron every minute → plan + send from outbox               │
 └───────────────┬───────────────────────────────────────┬─────────────────┘
                 ▼                                       ▼
        ┌─────────────────┐                   ┌─────────────────────────┐
        │  D1 (SQLite)    │                   │  LINE Platform          │
        │                 │                   │  Messaging API (push)   │
        │                 │                   │  Login: ID-token verify │
        │                 │                   │  Webhook → Worker       │
        └─────────────────┘                   └─────────────────────────┘
```

### Entry points
| Entry | Path | Auth |
|---|---|---|
| Member API (LIFF) | `POST /api/status`, `/api/google/link-start`, `/api/checkin/start`, `/api/checkin/submit`, `/api/consent`; `GET /api/liff-config` | LINE ID token, verified with LINE |
| Google sign-in | `GET /auth/google/admin`, `GET /auth/google/callback` | OIDC code + PKCE, single-use state |
| Health | `GET /healthz` | none |
| Admin API | `/admin/api/*` | Server-side session cookie + Origin check |
| LINE webhook | `POST /webhook/line` | HMAC-SHA256 signature on the raw body |
| Dev only | `/dev/tick`, `/dev/sent` | `ALLOW_TEST_CLOCK=1` + bearer token |
| Static assets | everything else | served by the assets binding before the Worker runs |
| Cron | `scheduled()` every minute | n/a |

### Bindings
`DB` (D1 or SQLite) · `ASSETS` (static files) · `IP_LIMIT` (rate limit, 120 req / 60 s per IP hash) · secrets: `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_LOGIN_CHANNEL_ID`, `LIFF_ID`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` · settings: `GOOGLE_ALLOWED_DOMAINS`, `ALLOW_PASSWORD_LOGIN` (break-glass), `ADMIN_TOKEN` (dev only). Self-hosted adds `PUBLIC_URL`, `INITIAL_ADMIN_EMAILS`, `SCHEDULER_BATCH_SIZE`, `BACKUP_KEEP`.

## 3. Tech stack

| Layer | Choice |
|---|---|
| Runtime | Cloudflare Workers (compatibility date 2026-10-01) **or** Node.js 24 in Docker; TypeScript |
| Data | Cloudflare D1, or SQLite via `node:sqlite`; 6 SQL migrations shared by both |
| Identity | LINE ID tokens (members' LINE identity), Google OIDC (member linking, admin sign-in) |
| Hosting (self) | Docker image, Docker Compose or Kubernetes (k3s) manifests, Cloudflare Tunnel |
| Messaging | LINE Messaging API (push/reply), LINE Login + LIFF SDK 2.24.0 |
| Admin UI | Plain HTML/JS, IBM Carbon Design System CSS, Leaflet 1.9.4 maps, SheetJS 0.20.3 (vendored) |
| i18n | Thai + English; server returns codes only, all strings in `public/i18n.js` |
| Tests | vitest + `@cloudflare/vitest-plugin` (tests run in the real Workers runtime), 124 tests; end-to-end smoke test of the Node server |
| Tooling | `wrangler` for local dev, `cf` CLI for Workers deploys, esbuild for the Node bundle |
| Size | ~2,300 lines of server TypeScript |

## 4. Code structure

```
src/
  index.ts       Worker entry: fetch() + scheduled(); picks the LINE client
  app.ts         HTTP router
  config.ts      Every tunable + message copy (single source)
  settings.ts    Admin-editable subset of config, stored in D1, applied per request/cron run
  clock.ts       Injectable Clock (SystemClock / FixedClock)
  time.ts        Asia/Bangkok dates, quiet-hours math
  geo.ts         Haversine distance, multi-point geofence
  line.ts        LineClient interface: push, reply, verifyIdToken
  line-http.ts   Real LINE client (timeouts, retry key, error mapping)
  line-fake.ts   Fake client with failure injection
  importer.ts    Roster stage → validate → publish
  google.ts      Google sign-in: start, callback, domain checks
  linking.ts     Link a LINE user to the member with a given email
  scheduler.ts   Outbox planner + sender
  checkin.ts     Check-in verification pipeline
  webhook.ts     Signature verify, dedupe, greet
  report.ts      Today view, anomaly detection, CSV export
  admin.ts       Admin API handlers
  auth.ts        Passwords, sessions, lockout
  messages.ts    Builds LINE message payloads
server/
  main.ts        Node runtime: HTTP server, static files, per-minute cron, rate limit, daily backups
  d1.ts          D1 API on node:sqlite (prepare/bind/first/all/run, atomic batch, migrations, backup)
public/          Admin pages, LIFF pages (liff/link, liff/checkin), linked.html, flyer.html, roster.js, i18n.js
migrations/      0001_init … 0006_google_signin
k8s/             Kubernetes manifests (app, PVC, service, cloudflared)
test/            vitest suites, one per module
scripts/         create-admin.mjs, perf.mjs
```

**Design rules:** only two abstractions (`Clock`, `LineClient`). No `Date.now()` in business logic, so every time-dependent path is testable with a fixed clock. Dates are Bangkok calendar dates; instants are UTC ms.

## 5. Data model (D1)

| Group | Tables |
|---|---|
| People | `members` (with Google `email`), `link_codes` (unused since Google sign-in) |
| Places | `locations`, `geofence_points` (retired, never deleted) |
| Roster | `import_batches`, `roster_dates`, `duties` |
| Check-in | `nonces`, `checkins` (every attempt) |
| Messaging | `outbox`, `webhook_events` |
| Admin | `admin_users` (with Google `email`), `admin_sessions`, `oauth_states`, `settings`, `audit_log` |
| Ops | `scheduler_heartbeat` |

**Duty state machine**

```
 PENDING ── check-in ok / override ──▶ CHECKED_IN  (late flag; source gps | override)
    │
    ├── start + 30 min, still pending ──▶ MISSED
    └── removed/changed by a newer publish ──▶ CANCELLED
```

## 6. Mechanics

### 6.1 Notification pipeline (scheduler + outbox)

| Kind | Trigger | Dedupe key | Deadline |
|---|---|---|---|
| REMINDER | 16:00 the day before, one per member per date | `R:<member>:<date>` | member's first start |
| PROMPT | duty start | `P:<duty>` | duty end |
| MISSED | start + 30 min, only if PENDING | `M:<duty>` | duty end |
| CONFIRM | right after check-in or override: an **email receipt** (never LINE since 1.1) | `EC:<duty>` | 60 min |

- **Channels:** every row has `channel` = `line` or `email`. Email copies of REMINDER/PROMPT/MISSED (keys `ER:` `EP:` `EM:`) are planned when Settings → *Email notices* is `fallback` (members not linked to LINE) or `all`. Email goes through `EmailClient` (SMTP via nodemailer on the Node server); links open the member page `/me`. A temporary SMTP error retries like LINE with the same Message-ID; a 5xx is final.
- **Exactly-once planning:** the UNIQUE `dedupe_key` means a row is created once, so a restart never double-sends.
- **Claiming:** each cron run leases up to 10 rows with a conditional `UPDATE` (lease 120 s), so overlapping runs cannot grab the same row.
- **Re-check before send:** the sender re-reads the duty first. It suppresses the message if the member already checked in, and cancels it if the duty no longer exists.
- **Idempotent retries:** target, payload and `X-Line-Retry-Key` are pinned before the first attempt and reused on every retry. Backoff 1, 2, 5, 10 min ±20% jitter, max 5 attempts, never past the deadline. A 429 honours `Retry-After`; other 4xx are terminal; a 409 counts as accepted only with a known request id.
- **Quiet hours** (21:00–06:00): jobs wait until 06:00. If that is already past the deadline, the row becomes `SUPPRESSED too_late_to_send` (or `FAILED deadline_passed` if it was waiting). CONFIRM ignores quiet hours, because it answers the member's own action.
- **CONFIRM fast path:** the row is inserted in the same transaction as the check-in and sent immediately via `ctx.waitUntil`; the scheduler retries it if that send fails.
- **Accepted ≠ acted:** "LINE API accepted" is stored separately from member actions; no state is called "delivered".
- **Heartbeat:** each run updates `scheduler_heartbeat`; the dashboard alerts if it is older than 3 min.

### 6.2 Check-in verification pipeline

```
LIFF page ──(ID token)──▶ /api/checkin/start ──▶ nonce (128-bit, TTL 3 min)
          ──(ID token, nonce, lat, lng, accuracy, client time)──▶ /api/checkin/submit
```

Server-side checks, in this order (each attempt is stored with its result):

1. **Identity:** ID token verified with LINE (audience = Login channel). A client-sent user id is never trusted.
2. **Assignment:** the server picks the member's open duty (or the next one today). The URL carries no duty id.
3. **Time window:** `[start − 15 min, end]` on the **server** clock. Late if after start + 30:00.
4. **Nonce:** single use, consumed atomically (a window rejection does not consume it).
5. **Accuracy:** reported accuracy ≤ the location's limit (default 50 m).
6. **Geofence:** inside **any** active point of the location (default radius 100 m). The distance stored is to the point with the smallest (distance − radius).

Results: `ok` · `outside_geofence` · `low_accuracy` · `outside_window` · `rejected(+reason)`; repeat submits return `already_checked_in`.

**Rate limits:** per IP via the binding, applied before any LINE call; per member 10 attempts / 5 min, counted from `checkins`.

**Anomaly flags** (admin review only, never auto-reject): identical coordinates (within 1e-6°) across members, implied speed > 150 km/h beyond the reported accuracy, ≥ 3 low-accuracy attempts, accuracy < 1 m, client clock skew > 5 min.

### 6.3 Roster import (stage → publish)

- Input: long-format CSV/XLSX, one row per duty: `date, staff_code, location_code, shift, start, end`. A date-only row marks a no-duty date. Buddhist-era years (2400–2800) are converted.
- Parsed in the browser (`public/roster.js`) and **revalidated on the server**. The in-page duty sheet (members × dates grid) uses the same importer.
- Publish is a **full snapshot of its dates**: unchanged PENDING duties are kept (no re-notification), changed ones are cancelled and re-created, missing ones are cancelled. CHECKED_IN/MISSED duties are never touched (a warning is shown). Dates in no published file are UNKNOWN, never treated as days off.
- Overnight shifts and overlapping duties per member are rejected.

### 6.4 Account linking (Google sign-in)

```
QR flyer / OA greeting ──▶ LIFF link page (in LINE) ──ID token──▶ /api/google/link-start ──▶ single-use state
   ──▶ phone's normal browser ──▶ Google (school account) ──▶ /auth/google/callback ──▶ email matches a roster member
   ──▶ members.line_user_id = verified LINE user ──▶ "Linked" page; back in LINE the link page re-checks /api/status
```

- Google refuses sign-in in in-app browsers, so the LIFF page opens the Google step with `liff.openWindow({ external: true })`.
  The LINE user id is captured server-side from the verified ID token *before* that step and stored with the state.
- State: 256-bit random, SHA-256 at rest, 10 min TTL, consumed atomically (`UPDATE … RETURNING`). PKCE S256.
- The ID token comes straight from Google's token endpoint (TLS + client secret). Checked: `iss`, `aud`, `exp`,
  `email_verified`, and the email domain **and** `hd` claim are both in `GOOGLE_ALLOWED_DOMAINS`.
- A LINE account linked to another member is refused. Re-linking a member replaces their old LINE account.
- Admins use the same callback. The state is also bound to the browser by a `SameSite=Lax` cookie (login CSRF), and the
  email must belong to an active admin.

### 6.5 Webhook

Verifies the HMAC-SHA256 of the raw body (Web Crypto) before parsing JSON, then dedupes on `webhookEventId`. It only replies (a greeting on follow, a help line on chat) and never changes state; failed replies are recorded as `reply_failed`.

### 6.6 Runtime configuration

All defaults live in `src/config.ts`. The scheduling subset (shift times, reminder time, windows, quiet hours, confirm on/off, message language) is stored in the D1 `settings` table, validated in `src/settings.ts`, and applied onto `config` at the start of every request and cron run. Changing a setting deletes future un-attempted REMINDER/MISSED rows so the next run re-plans them.

## 7. Security

| Area | Mechanism |
|---|---|
| Member identity | LINE ID-token verification on every member call |
| Admin sign-in | Google (Workspace domains only); optional break-glass password (PBKDF2-SHA256) when `ALLOW_PASSWORD_LOGIN=1` |
| Admin sessions | 256-bit random token, SHA-256 at rest, 12 h absolute / 2 h idle, `__Host-` cookie: HttpOnly, Secure, SameSite=Strict |
| CSRF | same-origin `Origin` required on every non-GET admin request |
| Brute force | lockout after 5 failures for 15 min; per-IP limiter on login |
| Account bootstrap | `INITIAL_ADMIN_EMAILS` (self-hosted) or `scripts/create-admin.mjs --google` (Workers) |
| Webhook | HMAC signature verified before parsing |
| Location data | read once at check-in, raw coordinates only in admin endpoints, nulled after 90 days by the scheduler |
| Auditability | every check-in attempt stored; overrides record the admin username; `audit_log` |

## 8. Testing

- 124 vitest tests running inside the Workers runtime against a real D1 with the migrations applied.
- `npm run smoke`: builds the Node server and runs an end-to-end flow against it (login, members, roster, scheduler, GPS check-in, dashboard).
- `FakeLineClient` injects failures: timeout, timeout after accept, 429, 5xx, 4xx, 409.
- `FixedClock` drives time-based tests (scheduler, windows, quiet hours, retention).
- Suites: schema · time + geo · import · roster parser · Google sign-in · scheduler (21) · check-in (22) · webhook · admin/report/anomalies/retention · HTTP client mapping · auth · confirmation · management.
- `npm run perf`: a local simulation of 150 links and a 10-person AM+PM day with the scheduler ticking every minute.

## 9. Development & deployment

```bash
npm test              # 124 tests
npm run typecheck     # tsc --noEmit
npm run smoke         # Node server end-to-end check
npm run dev           # wrangler dev; LINE_CLIENT=fake in .dev.vars, no LINE account needed
docker compose up -d --build   # self-hosted
kubectl apply -k k8s/          # self-hosted on Kubernetes
```

- **LINE client selection:** `LINE_CLIENT=fake` gives the in-memory fake; all secrets present gives the real HTTP client; otherwise nothing is sent and `/api/*` answers 503.
- **Self-hosted:** one replica only (SQLite single writer, scheduler must run once). Migrations run at start. Daily `VACUUM INTO` backups in `/data/backups`. No ports exposed; `cloudflared` is the only entrance. Guide: `docs/self-hosting.md`.
- **Workers:** `cf deploy` with secrets; D1 migrations applied separately.

## 10. Operational flows (system view)

**Admin:** sign in with Google → define locations + geofence points on a map → import members (with school emails) → print the sign-up flyer → import roster or fill the duty sheet → preview → publish → monitor the dashboard (live states, anomalies, failed outbox rows) → override if needed → export CSV.

**Member:** scan the flyer QR → LINE opens the link page (adds the OA as a friend) → sign in with the school Google account → receive pushes → tap Check in → LIFF gets the ID token + nonce + GPS → server verifies → result screen + CONFIRM push.
