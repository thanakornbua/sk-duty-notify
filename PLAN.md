# PLAN (v2: GPS check-in)

Source: "Duty Roster LINE Notification System: Spec" DRAFT v0.1. Rules: CLAUDE.md. v1 prototype archived on branch `legacy-v1`.
Decisions (2026-10-28): stay on Cloudflare Worker + D1; clean-slate rewrite; generic duties, AM/PM = two duties per person per day; the day-before message is a reminder with no ACK.
Decisions (2026-11-11): self-host on a school computer behind a Cloudflare Tunnel (Docker image; Docker Compose or Kubernetes/k3s), keeping the Workers target working from the same `src/`. Members link LINE with their school Google account instead of one-time codes; admins sign in with Google. Allowed domains are configured (`GOOGLE_ALLOWED_DOMAINS`). Source published under the MIT license. Printed QR flyers for sign-up (management approved).
Scope (2026-10-29): **5-person prototype, 10 duty days** first (OA quota 300/month; this needs 150–250). Nothing in the code caps the size; the 150-member figures below are design headroom only.

## Phases
- [x] 0. Archive v1 (`legacy-v1`), orphan `main`, schema, config, Clock, time helpers
- [x] 1. Members, locations, roster import, LIFF linking
- [x] 2. Scheduler + outbox against FakeLineClient
- [x] 3. LIFF check-in + server-side verification
- [x] 4. Admin: dashboard, overrides, anomalies, CSV export, location map picker, retention purge
- [~] 5. Live with real LINE credentials (OA "SK Roll Call"); webhook signature and ID-token verify confirmed. **Real-phone smoke test still to do**
- [x] 7. Real admin login (username + password, sessions) and Carbon Design System UI (2026-10-29)
- [x] 8. Management accounts page, Thai/English, in-page duty sheet, check-in completion screen + LINE confirmation, scheduling settings page (2026-10-29)
- [ ] 6. Pilot support: per-location distance/accuracy report for tuning radii
- [x] 9. Self-hosting (Node runtime, Docker image, Compose, k3s manifests, Cloudflare Tunnel), Google sign-in for members and admins, bulk member import with emails, printable QR flyer, open-source prep (2026-11-11)

## Layout
- `src/config.ts` every tunable + message copy. `src/clock.ts`, `src/time.ts` (Bangkok dates, quiet hours), `src/geo.ts` (haversine, any-point geofence).
- `src/line.ts` interface, `src/line-fake.ts` (failure injection, fake ID tokens `tok:<userId>`), `src/line-http.ts` (real push/reply/verify).
- `src/importer.ts` roster stage/publish, `src/linking.ts` one-time codes, `src/scheduler.ts` outbox, `src/checkin.ts` verification, `src/webhook.ts`, `src/report.ts` (today view, anomalies, CSV), `src/admin.ts`, `src/app.ts` router.
- `public/`: `admin.html` (members, link codes, import), `locations.html` (Leaflet), `dashboard.html`, `liff/link.html`, `liff/checkin.html`, `roster.js` (browser parser, tested), `vendor/xlsx.full.min.js` (SheetJS 0.20.3).
- `migrations/0001_init.sql`. `test/` vitest in the Workers runtime. `scripts/perf.mjs`.

## Assumptions
All values live in `src/config.ts`; all are unconfirmed defaults.
- Times: AM 06:30–12:00, PM 14:20–18:00. Reminder 16:00 the Bangkok calendar day before. Window [start − 15 min, end], both edges inclusive. Late = after start + 30:00 (exactly 30:00 is on time). MISSED push at start + 30 min. Quiet hours 21:00–06:00.
- Overnight shifts (end ≤ start) are rejected. A member cannot have overlapping duties in one file.
- Geofence: radius 100 m, accuracy 50 m by default, per location. A location has 1–20 points; a check-in passes inside ANY of them. Distance stored is to the point with the smallest (distance − radius).
- Reminder: one per member per date, listing all of that member's PENDING duties; deadline is that member's first start. If a duty is added to a date after its reminder went out, no second reminder is sent (the PROMPT still is).
- A row whose send time (after quiet hours) is already past its deadline is created SUPPRESSED `too_late_to_send`. Rows still waiting at their deadline become FAILED `deadline_passed` (visible on the dashboard).
- Prompt/missed buttons open `https://liff.line.me/{LIFF_ID}/checkin`. The URL carries no duty id; the server picks the open duty (or the next one today, so a too-early tap is logged as `outside_window`).
- Nonce: 128-bit random, TTL 3 min, one per attempt. Consumed by the attempt whatever its outcome (after the window check, per the spec's order); "Try again" fetches a new one. An attempt rejected for the window does NOT consume its nonce.
- A submit for an already checked-in duty answers 200 `already_checked_in` and is logged as `rejected/already_checked_in`.
- Rate limits: per member 10 attempts / 5 min, counted from `checkins`; per IP 120 / 60 s via the Workers rate-limit binding, before any LINE call (generous because school Wi-Fi NAT may share one IP).
- Consent: shown on first check-in-page use; check-in is refused (`no_consent`) until accepted; `members.consent_at`. Wording is a placeholder (open question 8).
- Retention: raw lat/lng nulled after 90 days by the scheduler; result, distance and accuracy are kept.
- Anomaly flags (admin review only): identical coords (1e-6 deg) across members, implied speed > 150 km/h beyond reported accuracy, ≥ 3 low-accuracy attempts, accuracy < 1 m, phone clock off by > 5 min.
- Import: long format (`date, staff_code, location_code, shift, start, end`); date-only row = explicit no-duty date; dates not in any published file are UNKNOWN. A file is a full snapshot for its dates: unchanged PENDING duties kept (no re-notification), changed ones cancelled and re-created, missing ones cancelled; CHECKED_IN/MISSED duties are never touched (warning only). BE years 2400–2800 are converted.
- Linking (since 2026-11-11): Google sign-in; the Google email must equal the member's roster email (stored lower-case, unique). Relinking a member replaces the old LINE account. A LINE account linked to another member is refused. The `link_codes` table is kept but unused. The LIFF page re-checks `/api/status` when the member returns from the browser.
- Google: accounts must be Workspace accounts on an allowed domain (email domain AND `hd`). Consent screen "Internal" if all domains are one Workspace organisation, otherwise "External" + published (basic scopes need no verification).
- Admins: Google-only accounts store `password_hash = ''` (never matches). Password login only with `ALLOW_PASSWORD_LOGIN=1`. Password reset from the Accounts page was removed (Google handles credentials).
- Self-hosted runtime: SQLite (WAL, foreign keys on, like D1), migrations at start (`d1_migrations` table), `SCHEDULER_BATCH_SIZE` 200 (no Workers per-invocation limits), in-memory IP rate limit, daily `VACUUM INTO` backup kept 14 days, `INITIAL_ADMIN_EMAILS` for the first admin. Visitor IP from `Cf-Connecting-Ip` (set by cloudflared).
- Webhook: greets `follow` with the link page, answers any private message with a help line. A shared location message is never a check-in.
- Admin auth: username + password. PBKDF2-SHA256 at 20,000 iterations (~5 ms CPU, inside the Workers Free plan's 10 ms; each hash stores its count, raise `config.auth.pbkdf2Iterations` to 100k on a paid plan). Passwords ≥ 12 chars, must not contain the username. 5 failures lock the account 15 min; login also behind the per-IP limiter. Sessions: random 256-bit token, SHA-256 stored, 12 h absolute / 2 h idle, `__Host-sdn_session` HttpOnly Secure SameSite=Strict; every non-GET admin request must carry a same-origin `Origin`. New admins get a 16-char temporary password from `scripts/create-admin.mjs` and must change it at first sign-in (all other API calls answer 403 until then); changing a password signs out the user's other sessions. No self-service admin creation or reset: rerun the script. Overrides record the username.
- `__Host-` cookies need HTTPS: for local UI work run `wrangler dev --local-protocol https` (plain http://localhost drops the cookie in Chromium).
- Staff and location codes allow letters, digits, `.`, `_`, `-` (max 32), e.g. `singha.su`.
- LIFF endpoint is `/liff` (registered in the LINE console as `https://<worker>.<subdomain>.workers.dev/liff`). LINE first opens the endpoint itself with `?liff.state=/link`; `public/liff/index.html` runs `liff.init()`, which forwards. (Missing until 2026-10-29: links returned "not found".)
- Management accounts: every account has the same rights (no roles). Any admin can create accounts (16-char temporary password, shown once, must be changed), reset others' passwords (signs them out, unlocks), disable/enable others. Nobody can disable or reset themselves via this page, so at least one active admin always remains. Accounts page shows last sign-in.
- Thai/English: per-browser choice (localStorage), default Thai unless the device language is English. Server responses are codes; `public/i18n.js` holds every string in both languages (a missing key logs `i18n: missing key`, which the browser test checks). Thai text uses IBM Plex Sans Thai Looped (shipped with Carbon). LINE messages use `messageLanguage` (default Thai) with Thai dates in the Buddhist era.
- Duty sheet (`/sheet`): members × dates grid (max 31 days), AM/PM ticks. A published sheet is a full snapshot of its date range, exactly like a file: unticked dates become explicit "no duty". New ticks use the chosen location and the current shift times; existing duties keep their own location/times; other shifts from file imports are carried over unchanged; checked-in/missed duties are locked.
- Check-in receipt: CONFIRM outbox row (channel email, key `EC:<duty>`, only if the member has a roster email) inserted in the same transaction as the check-in (only if this request's check-in is the stored one), sent immediately via `ctx.waitUntil` + `sendNow`, retried by the scheduler if that fails. Sent even during quiet hours, because it answers the member's own action. Overrides send one too. Receipt number `SKD-<duty id>-<check-in time base36>`. Switchable in Settings. (Before 1.1 this was a LINE push, key `C:<duty>`.)
- Scheduling settings (`/settings`): changes apply at once to check-in windows and to messages not yet attempted (future QUEUED REMINDER/MISSED rows with 0 attempts are deleted and re-planned on the next run). New shift times apply to duties published afterwards. Time fields are 24-hour HH:MM text (the browser time picker may show 12-hour "PM", which clashes with shift names).
- Branding (1.1): school emblem `public/brand/emblem-{32,96,192}.png` in the header, login/LIFF/member pages and the flyer. The SK app icon (`public/brand/logo.svg`, PNG 32/180/192/512, `favicon.ico`; Tan design system: ink tile, "SK" in IBM Plex Mono 600, one accent bar) is used only as favicon and home-screen icon. The 9000 px emblem original in `assets/` is not committed.
- Email (1.1): SMTP via nodemailer (self-hosted only; Workers has no EmailClient unless one is bound). Check-in receipts (CONFIRM) are always email to the roster email, whatever `emailMode`; LINE no longer sends a confirmation (saves LINE quota). `emailMode` (Settings) adds email copies of REMINDER/PROMPT/MISSED: off (default), fallback (members not linked to LINE when the message is planned), all. Email links open `/me`. Pool of 2 connections, 5 messages/s (`SMTP_RATE_PER_SECOND`). A temporary SMTP failure retries like LINE (same Message-ID); a 5xx is final.
- Member page `/me` (1.1): Google sign-in with the roster email; 30-day session, 14 days idle. Shows the last 90 days and the next 30 days, attendance rate, attempts without coordinates; browser check-in for members without LINE.
- Admin pages split (1.1): Roster (`/admin`) has members only; Duty sheet (`/sheet`) has the grid and the duty file import. The duty template is `public/duties-template.csv` (was roster-template.csv).
- Installer (1.1): `install.sh` for Ubuntu/Debian: Docker from Docker's apt repo (or k3s v1.33.5+k3s1 with `--k3s`), interactive `.env`, build, start, health check, next steps. Not run on the real school computer yet.
- Webhook replies that fail are logged and recorded as `reply_failed` on the event row.
- UI: Carbon Design System (white / g100 by device preference). Carbon's precompiled CSS has no type-helper classes, so headings use Carbon's type-scale sizes in `public/app.css`.
- Fake LINE client is used only when `LINE_CLIENT=fake`. Without real credentials the live Worker plans and sweeps but sends nothing, and `/api/*` answers 503.
- LIFF SDK 2.24.0 is pinned by URL but has no SRI hash: LINE's CDN sends no CORS header, so `integrity` would block it. Leaflet 1.9.4 has SRI.

## Tests (124, `npm test`; `npm run smoke` for the Node server)
schema 6 · time+geo 5 · import 7 · roster parser 4 · Google sign-in 9 · scheduler 21 · check-in 22 · webhook 4 · admin/report/anomalies/retention 11 · HTTP client mapping 4 · auth 11 · confirmation 9 · management (accounts, settings, sheet data) 8 · webhook 5.
Spec 12 acceptance criteria → `test/checkin.test.ts` "AC1"–"AC3", `test/scheduler.test.ts` "never twice, even after a restart" (AC4), `test/admin.test.ts` "AC5".

## Performance
- Local proxy (`npm run perf`: 150 links, 10-person AM+PM day, scheduler every minute 15:00 d-1 → 19:00 d): functionally exact (38 pushes = 10 reminders + 20 prompts + 8 missed; 12 checked in, 8 missed). Its CPU numbers are NOT usable on this host: a trivial request measured 29 ms p50 under load average ~9, so the floor is above the target.
- Live Cloudflare CPU (GraphQL `workersInvocationsAdaptive`) is the real figure; see the report in the session / update here as data accumulates.

## Deployment (live)
- https://<worker>.<subdomain>.workers.dev, D1 `sk-duty-notify` (id in `deploy/cloudflare.config.ts`), cron every minute, rate-limit binding `CHECKIN_IP_LIMIT`.
- 2026-10-29: live D1 reset (all v1 tables dropped, incl. `d1_migrations`), v2 `0001_init.sql` applied, version `25f92da5` deployed.
- Deploy: copy `src/ migrations/ public/ package.json tsconfig.json` + `deploy/*.ts` into a clean dir; inside it make `node_modules/` with symlinks to each repo package plus the global `cf` package; then `cf deploy --secrets-file <json>` (secrets file only in the scratchpad, deleted after).
- 2026-10-29: synthetic seed cleared (live DB empty); LINE secrets set; version `5f088245` deployed.
- Secrets set: `ADMIN_TOKEN` (local copy in gitignored `.admin-token`), `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_LOGIN_CHANNEL_ID`, `LIFF_ID` (local source: gitignored `.env`). NOT set (dev only): `LINE_CLIENT`, `ALLOW_TEST_CLOCK`.
- Verified live: LINE webhook test 200 (channel secret correct), `/api/liff-config` returns the LIFF id, a forged ID token gets 401 via LINE's real verify endpoint, unsigned webhook 401. Pushes not yet exercised (no members).
- OA: quota type limited, 300 messages/month, chat mode on (turn off OA Manager greeting/auto-response to avoid double replies).
- Bug found on first live run and fixed: `HttpLineClient` called the native fetch as `this.fetchFn(...)` ("Illegal invocation" in Workers); now wrapped. Regression test mimics the native `this` check.

## Phase 5 checklist (needs you)
1. ~~LINE Developers: one provider with a Messaging API channel (the OA) and a LINE Login channel; LIFF app on the Login channel, size Full, endpoint `https://<worker>.<subdomain>.workers.dev/liff`, scope `openid profile`.~~ done
2. ~~OA webhook URL~~ done; auto-reply/greeting off in OA Manager: confirm.
3. ~~Secrets + redeploy~~ done 2026-10-29. The 5 people must be testers on the Login channel while it is Developing.
4. Smoke: link two test phones (iOS + Android), one duty starting in ~20 min, check in inside/outside the geofence, low accuracy indoors, location permission off.
5. Check the OA plan's monthly quota. 5 people on AM+PM: 5 reminders + 10 prompts + up to 10 missed = 15–25 pushes per duty day (~330–550/month at 22 duty days). Replies to webhook events are free; pushes count.
6. ~~Clear the synthetic seed~~ done 2026-10-29.

## Still open (spec 13)
1 roster source · 2 real coordinates / indoor sites · 3 window rules · 4 miss alerts to admin (now: dashboard only) · 5 swaps (now: re-import or override) · 6 OA quota · 7 channel ownership · 8 retention + consent wording · 10 admin auth.

## Deferred (do NOT build)
Shift-swap workflow, device attestation / Wi-Fi / beacon checks, multi-tenant, payroll/scoring, client read-only role.
