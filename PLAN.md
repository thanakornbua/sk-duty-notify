# PLAN

Prototype of the LINE duty-roster notification system. Rules live in CLAUDE.md.

## Phases
- [x] 1. Scaffold + schema
- [x] 2. Import (SheetJS admin page, stage/publish)
- [x] 3. Scheduler + outbox (FakeLineClient)
- [x] 4. Webhook + binding, perf script
- [x] 5. Dashboard
- [ ] 6. Real LINE smoke test (needs confirmed test OA)

## Layout
- `src/config.ts` all tunables and message copy; `src/clock.ts` Clock; `migrations/` D1 SQL; `test/` vitest in the Workers runtime.

## Assumptions
- Instants are UTC epoch ms (INTEGER); duty dates are Bangkok `YYYY-MM-DD` TEXT. Bangkok is a fixed UTC+7 (no DST).
- AM/PM cutoffs 12:00 / 18:00 are unconfirmed defaults. ACK cutoff defaults to 06:30 on the duty day (when the AM push starts); easy to change in config.
- `assignments.is_active` mirrors "owning revision is ACTIVE" so the active-revision unique indexes can be partial indexes; publish must flip it atomically with revision status.
- `action_states.revision` / `notification_jobs.revision` start at 1; it only bumps if an action is re-issued (not built yet).
- Binding codes table is deferred to Phase 4 (not in the Phase 1 table list).
- Tests use `@cloudflare/vitest-plugin` (the renamed `vitest-pool-workers`) with vitest 4; D1 storage is not isolated per test, so tests clear tables in `beforeEach`.
- `npm install-scripts approve esbuild workerd` was needed for local runs.

### Phase 2 assumptions
- Admin UI is `public/admin.html` (served by the Workers assets binding); SheetJS 0.20.3 is vendored in `public/vendor/` (sha256 cc015130…6f41, from cdn.sheetjs.com) so the version is pinned and no CDN is hit.
- Grid -> JSON logic is plain JS in `public/grid.js`, shared by the browser and the tests. The server never trusts it and revalidates in `src/importer.ts`.
- Grid layout: row 1 = dates, column A = position labels, cells = staff IDs. Header dates may be Excel serials (1900 or 1904 via the workbook flag), `YYYY-MM-DD`, or day-first `DD/MM/YYYY`; years 2400-2800 are treated as Buddhist era (-543); anything outside 2000-2200 is rejected.
- A date column that is entirely empty means an explicit NO_DUTY day. Dates not in the file are not stored, so they stay UNKNOWN. A partly filled column is an error.
- A revision is a full snapshot for the dates it lists: publishing supersedes the previous one, so dates only in the old file become UNKNOWN again.
- Dates in the past are not rejected. Roster positions are `config.positions` (P1..P10, synthetic).
- `POST /admin/people` is a synthetic seeding helper so "known staff IDs" has something to check against. Admin auth is a STUB shared bearer token (`ADMIN_TOKEN`).

### Phase 3 assumptions
- Each run: plan (today + tomorrow Bangkok dates) -> cancel withdrawn -> expire past-cutoff PENDING actions -> reap expired leases -> claim <= batchSize -> send -> heartbeat. Planning is one cheap probe query per run when nothing is new.
- Every job's deadline is its action's cutoff (ACK 06:30, AM 12:00, PM 18:00 on the duty day). An action planned after its cutoff is created EXPIRED with no job. An INITIAL job that reaches its deadline unsent is FAILED `deadline_passed` (visible); a REMINDER in that state is SUPPRESSED.
- ACK for a duty day can therefore still go out as late as the evening before the duty day is published (any time before 06:30). If that is "late at night" for you, add a per-kind send window to config.
- A reminder is only created if accepted + 30 min is before the cutoff. Its revision matches the initial job.
- `attempts` counts real push calls (incremented when target/payload/retry key are pinned, before the call). Backoff 1, 2, 5, 10 min with +-20% jitter; 429 uses Retry-After as given. Retries that would land at or after the deadline fail with `deadline_passed: <cause>`.
- Timeout and unexpected exceptions from the client are treated as "maybe accepted": retried with the same key. 409 is believed only if an accepted request id is known (from the response, or already stored on the job); otherwise FAILED.
- An unbound recipient is rechecked every 5 min (no attempt consumed) until the deadline, then FAILED `unbound`.
- Message copy: ACK = roster text + a buttons template; AM/PM/reminder = a buttons template. Postback data is `a=<action_state id>&r=<revision>`. Roster uses synthetic labels.
- Superseded/withdrawn assignments cancel their queued jobs/actions. Re-publishing a corrected roster creates new assignment rows, so a person already notified can be notified again; corrections are deferred.
- `scheduled()` only sends when `LINE_CLIENT=fake` (dev, in-memory, nothing reaches LINE). Otherwise it plans/expires/heartbeats only, until the real client in Phase 6.
- `scheduler_heartbeat` (migration 0002) is the Phase 5 liveness source.

### Phase 4 assumptions
- `POST /webhook/line`: signature checked on the raw bytes (HMAC-SHA256, `crypto.subtle.verify`, constant time) before any JSON parsing. Missing secret => 500 (fails closed). Events without `webhookEventId` are ignored.
- Dedupe row, state change and audit row commit in ONE `db.batch`, so a DB failure leaves no trace and LINE's redelivery is processed normally. The reply is sent after the commit and its failure is ignored. Outcome in `webhook_events` comes from SQL `changes()` in the same transaction.
- The press time is the server clock at receipt, not LINE's `timestamp`. Exactly start+30:00 is on time; one ms later is late. Window opens at the initial send time (`opens_at`) and closes at the cutoff.
- Only `source.type == "user"` events act (private chats). Group/room events are recorded as ignored.
- Binding codes: 8 chars from a 31-symbol alphabet (no I, L, O, 0, 1), 15 min TTL, one use. Issuing a new code revokes the older unused one. A failed, expired, revoked and unknown code all get the same reply. No rate limit on guesses in the prototype (31^8 space); add one before real use.
- Re-binding a staff ID to a new LINE account replaces the old one (old account loses access immediately); a LINE account already linked to another staff ID is refused and the code is NOT consumed. Jobs already pinned to the old user keep their pinned target for retries.
- `LineClient` gained `reply()`. Dev-only: `ALLOW_TEST_CLOCK=1` enables the `x-test-now` header and `/dev/tick`, `/dev/sent` (also behind the admin token). Never set it in production.
- Perf: `npm run perf` (see scripts/perf.mjs). It measures CPU of the whole local workerd process via /proc schedstat, which includes local SQLite and runtime overhead, so it is an UPPER-BOUND proxy for the billed Worker CPU, not the same number.

### Phase 5 assumptions
- `public/dashboard.html` is plain HTML + one inline module script, no libraries, no `innerHTML` (DOM built with `textContent`). It polls `GET /admin/dashboard.json` every 30 s. Auth is the same STUB bearer token as the admin page and is labelled as such on the page.
- Each action cell shows two separate lines: Push (LINE API accepted / queued / retrying / failed) and User (pending / done / late / expired). The word "delivered" appears nowhere. LINE user ids are never sent to the page.
- "Today/tomorrow" are Bangkok calendar dates. Missing roster data shows as UNKNOWN and raises `roster_missing` (today: high; tomorrow: warn before 12:00, high after). An explicit NO_DUTY day raises nothing.
- Other alerts: no active revision, failed jobs, unbound people on duty today/tomorrow, actions expired with no push ever accepted, scheduler heartbeat NEVER/STALE (> 3 min), queue more than 3 min overdue. Thresholds live in `config.ts`.
- The page itself was not opened in a real browser here; its data endpoint and the HTML's constraints are tested, the rendering code is not.

## Deployment (live)
- URL: https://<worker>.<subdomain>.workers.dev (Cloudflare Worker + D1 `sk-duty-notify`, id in `deploy/cloudflare.config.ts`). Cron `* * * * *`.
- Deployed with the `cf` CLI from a scratch copy of the project (the repo keeps `wrangler.jsonc`; `cf migrate` was run only in the copy). The generated `deploy/cloudflare.config.ts` + `deploy/wrangler.config.ts` are kept for repeat deploys: copy `src/ migrations/ public/ package.json tsconfig.json` and these two files into a clean dir, symlink node_modules, then `cf deploy --secrets-file <json>`.
- Remote migrations: `cf d1 migrations apply <db id> --dir migrations`.
- Secrets: only `ADMIN_TOKEN` (random 48 hex chars; a local copy is in the gitignored `.admin-token`). It is still the STUB admin auth: one shared bearer token over HTTPS, no per-user login. `LINE_CHANNEL_SECRET` and `LINE_CHANNEL_ACCESS_TOKEN` are NOT set, so the webhook fails closed (500) and nothing can be sent. `LINE_CLIENT` and `ALLOW_TEST_CLOCK` are NOT set, so `/dev/*` is 404 and the scheduler only plans/expires/heartbeats.
- Pages: `/admin` (import) and `/dashboard` (Cloudflare redirects `.html` to the pretty URL). Both ask for the admin token.
- The database is empty until someone seeds people (`POST /admin/people`) and imports a roster. Synthetic data only.

### Live data + message preview
- Live DB was seeded with synthetic data on 2026-10-28: 30 staff (S001-S030, "Person N", NO LINE accounts linked), roster revision 1 with DUTY on 2026-10-28/29/30 (staff 1-10, 11-20, 21-30), explicit NO_DUTY on 10-31, and 11-01 left UNKNOWN. Because nobody is linked and `LINE_CLIENT`/LINE secrets are unset, nothing is ever sent; the dashboard therefore shows `unbound_on_duty`, `never_notified` (today's ACK window had already closed when the roster was loaded) and `queue_overdue` (jobs are due but no sender is enabled). That is expected until Phase 6.
- `/preview` (public/preview.html) + `GET /admin/preview.json`: a mock of the chat for one duty day, built with `src/messages.ts`, the same function the scheduler uses, so copy, buttons and postback data cannot drift. Rendering is an approximation of LINE's UI. Tests check LINE limits for the buttons template (text <= 160, label <= 20, data <= 300, altText <= 400).
- Fixed: roster lines and dashboard rows now follow `config.positions` order (P2 before P10); SQL ORDER BY sorted them alphabetically.
