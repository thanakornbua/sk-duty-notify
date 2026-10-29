# sk-duty-notify (v2): project rules

PROTOTYPE of a LINE duty-roster notification system with **GPS-verified check-in**. Spec: "Duty Roster LINE Notification System: Spec" DRAFT v0.1. v1 (ACK/AM/PM postback buttons) is archived on branch `legacy-v1`.
Keep code small and readable; no abstractions beyond `Clock` and `LineClient`.

## Stack
TypeScript, one Cloudflare Worker + D1 (HTTP API, static assets in `public/`, `scheduled()` every minute). vitest with `@cloudflare/vitest-plugin`. No Docker, Redis, or ORM. LIFF SDK and Leaflet from CDNs at pinned versions; SheetJS and Carbon styles vendored.
- UI: IBM Carbon Design System (`public/vendor/carbon-styles.min.css`, @carbon/styles 1.118.0) with Carbon class names (`cds--*`) and Carbon tokens only; theme zone `cds--white` / `cds--g100` from `prefers-color-scheme`. Shared builders in `public/admin-common.js`. Build DOM with `el()`, never `innerHTML`.

## Domain
- ~150 members; a duty = member + location + Bangkok date + shift (start/end). AM/PM are two duties per person per day.
- Messages, all individual pushes: REMINDER 16:00 the day before (one per member per day, all of their duties, info only), PROMPT at each duty start (button opens the LIFF check-in page), MISSED at start + 30 min only if still PENDING. Never repeated; never in quiet hours.
- Check-in = LIFF page -> ID token + server-issued nonce + browser geolocation. Never the LINE chat "location message".
- Duty states: PENDING / CHECKED_IN (late flag, source gps|override) / MISSED / CANCELLED. Attempt results: ok / outside_geofence / low_accuracy / outside_window / rejected (+ reason).
- Roster: long-format CSV/XLSX (one row per duty), parsed in the browser (`public/roster.js`), revalidated on the server. Dates not in any published file are UNKNOWN, never a day off.

## Hard rules
- Duty dates are Asia/Bangkok calendar dates. Instants are UTC ms. Never derive the duty date from the UTC date.
- Every time-dependent function takes an injected `Clock`. No `Date.now()` in business logic.
- LINE sits behind `LineClient` (push, reply, verifyIdToken). `FakeLineClient` has failure injection: timeout, timeout-after-accept, 429, 5xx, 4xx, 409.
- All tunables and message copy: ONE file, `src/config.ts`.
- Check-in verification order (spec 8.2): identity (ID token verified with LINE, never a client-sent user id) -> assignment -> time window on the SERVER clock -> nonce (single use, consumed atomically) -> accuracy -> geofence (inside ANY point). Store every attempt.
- Keep "LINE API accepted" separate from "member acted". Never name a state "delivered".
- Raw coordinates only in admin endpoints; purged after `config.locationRetentionDays`.
- Admin auth: username + password (PBKDF2-SHA256, iterations stored per hash), server-side sessions in an HttpOnly, Secure, SameSite=Strict `__Host-` cookie, Origin check on every non-GET, lockout after failures, forced change of temporary passwords. Admins are created with `scripts/create-admin.mjs`. `ADMIN_TOKEN` is a dev-only bearer for `/dev/*`.
- Geofence points are never deleted: editing a location retires them (`retired_at`), because check-in attempts reference them.
- Synthetic data only. No real names, coordinates of real sites, tokens, or secrets in the repo. Secrets via wrangler/cf secrets or `.dev.vars` (gitignored).

## Scheduler
- `outbox` rows with a UNIQUE `dedupe_key` (REMINDER R:member:date, PROMPT P:duty, MISSED M:duty): created once, so restarts never double-send.
- Claim up to `config.batchSize` per run with a conditional UPDATE lease. Re-read the duty before sending; suppress if checked in, cancel if the duty is gone.
- Pin target + payload + `X-Line-Retry-Key` before the first attempt; reuse on retry. Retry 1, 2, 5, 10 min with jitter, max 5, deadline = duty end (reminder: first start). 429 honours Retry-After; other 4xx terminal; 409 accepted only with a known request id.

## Webhook
- HMAC-SHA256 of the RAW body (Web Crypto verify) before JSON parsing. Dedupe on `webhookEventId`. It only greets (follow) and points to the LIFF pages; no state changes.

## Working style
- Ask only if blocked; otherwise pick the simplest option, put it in config, and note it in PLAN.md under "Assumptions".
- Run `npm test` and `npm run typecheck` before reporting. Report results honestly, including what was not verified.
- Deferred (do NOT build): shift-swap workflow, device attestation / Wi-Fi / beacon checks, multi-tenant, payroll/scoring, client read-only role.
