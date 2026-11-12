# sk-duty-notify (v2): project rules

PROTOTYPE of a LINE duty-roster notification system with **GPS-verified check-in**. Spec: "Duty Roster LINE Notification System: Spec" DRAFT v0.1. v1 (ACK/AM/PM postback buttons) is archived on branch `legacy-v1`.
Keep code small and readable; no abstractions beyond `Clock`, `LineClient` and `EmailClient`.

## Stack
TypeScript. `src/` is one Cloudflare Worker + D1 (HTTP API, static assets in `public/`, `scheduled()` every minute). The same code also runs self-hosted: `server/` (Node.js 24, SQLite via a D1-compatible adapter, static files, cron, backups), packaged by `Dockerfile`, deployed with `compose.yaml` or `k8s/` behind a Cloudflare Tunnel. `src/` must stay runtime-neutral: Web APIs only, no `node:` imports, no Workers-only APIs without a shim in `server/`. vitest with `@cloudflare/vitest-plugin`; `npm run smoke` checks the Node server end to end. No Redis or ORM. Open source (MIT). LIFF SDK and Leaflet from CDNs at pinned versions; SheetJS and Carbon styles vendored.
- UI: IBM Carbon Design System (`public/vendor/carbon-styles.min.css`, @carbon/styles 1.118.0) with Carbon class names (`cds--*`) and Carbon tokens only; theme zone `cds--white` / `cds--g100` from `prefers-color-scheme`. Shared builders in `public/admin-common.js`. Build DOM with `el()`, never `innerHTML`.

## Domain
- ~150 members; a duty = member + location + Bangkok date + shift (start/end). Shifts are configured by management on the Settings page (`config.shiftList`: code, optional display name, start, end; max 8; default AM/PM); each duty stores its own times, so changing a shift only affects duties published afterwards. Messages show the display name.
- Messages, all individual: REMINDER 16:00 the day before (one per member per day, all of their duties, info only), PROMPT at each duty start (button opens the LIFF check-in page), MISSED at start + 30 min only if still PENDING: LINE pushes, plus email copies by setting `emailMode` (off / fallback = members not linked to LINE / all). CONFIRM = an email RECEIPT to the roster email right after a successful check-in or override (setting, default on; never a LINE push since 1.1, to save LINE quota). Never repeated; REMINDER/PROMPT/MISSED never in quiet hours.
- Email sits behind `EmailClient` (src/email.ts); server/smtp.ts implements it with nodemailer. Every email is multipart: plain text + HTML from one `EmailDoc` (src/email-render.ts: table layout, inline styles, all values escaped, emblem from PUBLIC_URL). Each outbox row has a `channel` (line | email); email keys are the LINE keys prefixed with E (ER/EP/EM/EC).
- Member page `/me` (src/portal.ts): Google sign-in with the roster email -> member session; own duties, attempts (no coordinates), browser check-in through the same verification (identity = the Google session, attempt `via` = web).
- Branding: the school emblem (`public/brand/emblem-*`) everywhere in the UI; the SK app icon (`public/brand/logo*`, `favicon.ico`) ONLY as favicon / home-screen icon. Credits page `/credits` names the developer with the "thanakorn." wordmark (thanakorn. design system: Geist 600, ember dot), not "Tan".
- Two admin pages: Roster (`/admin`, members only) and Duty sheet (`/sheet`, duties only: grid + file import). Duties from a file or the grid go through the same stage/publish importer.
- Linking LINE to a member: Google sign-in with the member's school account; the roster email must match. Started from the LIFF link page (LINE ID token), finished in the phone's normal browser (Google blocks in-app browsers). No one-time codes.
- Check-in = LIFF page (ID token) or member page (Google session) -> server-issued nonce + browser geolocation. Never the LINE chat "location message".
- Duty states: PENDING / CHECKED_IN (late flag, source gps|override) / MISSED / CANCELLED. Attempt results: ok / outside_geofence / low_accuracy / outside_window / rejected (+ reason).
- Roster: long-format CSV/XLSX (one row per duty), parsed in the browser (`public/roster.js`), revalidated on the server. Dates not in any published file are UNKNOWN, never a day off.

## Hard rules
- Duty dates are Asia/Bangkok calendar dates. Instants are UTC ms. Never derive the duty date from the UTC date.
- Every time-dependent function takes an injected `Clock`. No `Date.now()` in business logic.
- LINE sits behind `LineClient` (push, reply, verifyIdToken). `FakeLineClient` has failure injection: timeout, timeout-after-accept, 429, 5xx, 4xx, 409.
- All tunables and message copy: ONE file, `src/config.ts`. The scheduling subset (shift times, reminder time, windows, quiet hours, confirmation, message language) is editable on the Settings page: stored in D1 `settings`, validated in `src/settings.ts`, applied onto `config` at the start of every request and cron run. `config.ts` holds the defaults.
- Two languages, Thai and English. UI text only via `public/i18n.js` (`t()`, both languages for every key); the server returns error/issue CODES, never sentences. LINE copy per language in `config.messages`.
- Check-in verification order (spec 8.2): identity (ID token verified with LINE, or the member-page Google session; never a client-sent user id) -> assignment -> time window on the SERVER clock -> nonce (single use, consumed atomically) -> accuracy -> geofence (inside ANY point). Store every attempt.
- Keep "LINE API accepted" separate from "member acted". Never name a state "delivered".
- Raw coordinates only in admin endpoints; purged after `config.locationRetentionDays`.
- Google sign-in (src/google.ts): OIDC code flow + PKCE, single-use hashed state (10 min). Accept only `email_verified` accounts whose email domain AND `hd` claim are in `GOOGLE_ALLOWED_DOMAINS`. Admin sign-ins are also bound to the browser with a SameSite=Lax state cookie.
- Admin auth: Google sign-in by email (accounts added on the Accounts page, `INITIAL_ADMIN_EMAILS`, or `scripts/create-admin.mjs --google`). Server-side sessions in an HttpOnly, Secure, SameSite=Strict `__Host-` cookie, Origin check on every non-GET. Username + password (PBKDF2-SHA256, lockout, forced change of temporary passwords) is break-glass only, off unless `ALLOW_PASSWORD_LOGIN=1`. `ADMIN_TOKEN` is a dev-only bearer for `/dev/*`.
- Geofence points are never deleted: editing a location retires them (`retired_at`), because check-in attempts reference them.
- Synthetic data only. No real names, emails, coordinates of real sites, tokens, account ids or secrets in the repo (it is public). Secrets via wrangler/cf secrets, `.dev.vars`, `.env` or `k8s/*.env` (all gitignored).
- Self-hosted runs exactly one replica (SQLite single writer; the scheduler must run once per minute).

## Scheduler
- `outbox` rows with a UNIQUE `dedupe_key` (REMINDER R:member:date, PROMPT P:duty, MISSED M:duty): created once, so restarts never double-send.
- Claim up to `config.batchSize` per run with a conditional UPDATE lease. Re-read the duty before sending; suppress if checked in, cancel if the duty is gone.
- Pin target + payload + `X-Line-Retry-Key` before the first attempt; reuse on retry. Retry 1, 2, 5, 10 min with jitter, max 5, deadline = duty end (reminder: first start). 429 honours Retry-After; other 4xx terminal; 409 accepted only with a known request id.

## Webhook
- HMAC-SHA256 of the RAW body (Web Crypto verify) before JSON parsing. Dedupe on `webhookEventId`. It only greets (follow) and points to the LIFF pages; no state changes.

## Working style
- Ask only if blocked; otherwise pick the simplest option, put it in config, and note it in PLAN.md under "Assumptions".
- Run `npm test`, `npm run typecheck` and (when `server/` or anything it touches changed) `npm run smoke` before reporting. Report results honestly, including what was not verified.
- Deferred (do NOT build): shift-swap workflow, device attestation / Wi-Fi / beacon checks, multi-tenant, payroll/scoring, client read-only role.
