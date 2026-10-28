# sk-duty-notify — project rules

PROTOTYPE of a LINE duty-roster notification system. Goal: prove the time model, state machine, and LINE round-trip. Not production hardening. Keep code small and readable; no abstractions beyond `Clock` and `LineClient`.

## Stack
TypeScript, Cloudflare Worker + D1, wrangler/miniflare for local dev, vitest. One Worker serves the HTTP routes, the static admin UI, and `scheduled()`. No Docker, Redis, or ORM.

## Domain
- ~150 staff in the rotation pool; 10 on duty per duty day. The same 10 do AM and PM.
- Per duty day `d`, each of the 10 gets three individual LINE pushes (no broadcast, no group):
  1. 16:00 on d-1 (calendar day before): roster for d, both shifts, button "Acknowledge" (ACK)
  2. 06:30 on d: AM shift, button "Check-In AM"
  3. 14:20 on d: PM shift, button "Check-In PM"
- Each person has 3 independent states per day: ACK, AM, PM. None affects another.
- Reminder: ONE per person per action per day, at (initial send API-accepted time + 30 min), only if the action is still PENDING. Never repeat.
- Late: Check-In after (start + 30 min) is recorded late but still accepted until cutoff. Cutoffs are config (defaults AM 12:00, PM 18:00, unconfirmed). Expired actions are marked EXPIRED, never sent late at night.
- Day states: DUTY / NO_DUTY / UNKNOWN. Missing data is UNKNOWN, never assumed a day off. "Tomorrow" is the calendar day, even if today is a holiday.
- Roster source: XLSX (columns = dates, rows = positions, cells = staff ID). Parsed in the browser (pinned SheetJS); the server receives normalized JSON and revalidates.

## Hard rules
- Duty dates are Asia/Bangkok calendar dates. Job timestamps are UTC. Never derive the duty date from the UTC date (06:30 Bangkok = 23:30 UTC the previous day).
- Every time-dependent function takes an injected `Clock`. No `Date.now()` in business logic.
- LINE sits behind a `LineClient` interface. `FakeLineClient` first, with failure injection: timeout, 429, 5xx, 409 (duplicate retry key).
- Send times, offsets, cutoffs, batch size, message copy: ONE config file (`src/config.ts`).
- Keep "API accepted" separate from "user acted" in schema and UI. Never name a state "delivered".
- Synthetic data only. No real names, tokens, or secrets in the repo. Secrets via wrangler secrets / `.dev.vars` (gitignored).

## Scheduler design
- Single cron every minute. Query due jobs by index (status, next_attempt_at).
- Claim up to `config.batchSize` (default 10) per run with a conditional UPDATE lease (2 min, owner id).
- Before sending: re-read the action; if already completed or assignment withdrawn, SUPPRESS/CANCEL reminders.
- Pin payload + target user + `X-Line-Retry-Key` (UUID) before the first attempt; reuse on retry.
- On API accept: store `accepted_at` and request id; create the REMINDER job if the action is still PENDING.
- Retry ~1, 2, 5, 10 min with jitter, max 5 attempts, every job has a deadline (cutoff). 429 respects Retry-After. 4xx is terminal with a visible error. On 409, check for a stored accepted request id before treating as accepted.
- Job states: QUEUED, LEASED, API_ACCEPTED, RETRY_WAIT, FAILED, SUPPRESSED, CANCELLED.
- Action states: PENDING, COMPLETED (on_time/late), EXPIRED, CANCELLED.

## Webhook
- Verify HMAC-SHA256 of the RAW body with the channel secret (Web Crypto, constant-time compare) before JSON parsing.
- Dedupe on `webhookEventId`. Commit the action BEFORE replying. If the DB fails, return 5xx so LINE redelivers.
- Postback data carries only an action id + revision; look everything else up server-side. Check `source.userId` == bound user of that assignment. A forwarded button pressed by someone else must not complete it.
- Double-tap is idempotent and replies with existing status.
- Binding: admin creates a one-time short-lived code per staff ID; user types it in the private chat; the webhook supplies userId. Never bind by display name. One active LINE user per staff ID.

## Phases (STOP after each, run tests, show results, wait for "go")
1. Scaffold + schema (migrations, uniqueness tests)
2. Import (admin page w/ SheetJS, stage/publish, validation)
3. Scheduler + outbox against FakeLineClient
4. Webhook + binding (+ perf script: 150 bindings, 10-person day, P95 CPU per scheduled()/webhook; target < 8 ms Free tier; report, don't tune blindly)
5. Dashboard (plain HTML; admin auth is a STUB token, mark clearly)
6. Real LINE smoke test — only after user confirms a test OA exists

## Deferred (do NOT build)
Revision diffs/corrections, override UI, backups, retention jobs, Docker fallback, GPS/QR.

## Working style
Ask only if blocked; otherwise pick the simplest option, put it in config, and note it in PLAN.md under "Assumptions".
