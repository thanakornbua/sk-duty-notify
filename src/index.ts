import { handleRequest } from "./app";
import { FixedClock, systemClock } from "./clock";
import type { LineClient } from "./line";
import { FakeLineClient } from "./line-fake";
import { HttpLineClient } from "./line-http";
import { runScheduler } from "./scheduler";
import { loadSchedule } from "./settings";

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  /** Optional Workers rate-limit binding, keyed on a hash of the client IP: /api/* (before any LINE call) and admin login. */
  IP_LIMIT?: RateLimit;
  LINE_CHANNEL_SECRET?: string;
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  /** LINE Login channel id of the LIFF app (the ID token's `aud`). Same provider as the Messaging API channel. */
  LINE_LOGIN_CHANNEL_ID?: string;
  LIFF_ID?: string;
  /** Dev/perf only: bearer for /dev/* (with ALLOW_TEST_CLOCK). Admin pages use username + password. */
  ADMIN_TOKEN?: string;
  /** "fake" = dev only: in-memory LINE, fake ID tokens accepted. Never set in production. */
  LINE_CLIENT?: string;
  /** Dev/perf only: x-test-now header and /dev/* routes. Never set in production. */
  ALLOW_TEST_CLOCK?: string;
}

// Dev-only in-memory client, kept for the isolate's lifetime.
const fake = new FakeLineClient();

/** fake (dev) | real (all secrets present) | undefined (nothing is sent, check-in API answers 503). */
export function lineClientFor(env: Env): LineClient | undefined {
  if (env.LINE_CLIENT === "fake") return fake;
  if (env.LINE_CHANNEL_ACCESS_TOKEN && env.LINE_LOGIN_CHANNEL_ID) {
    return new HttpLineClient(env.LINE_CHANNEL_ACCESS_TOKEN, env.LINE_LOGIN_CHANNEL_ID);
  }
  return undefined;
}

export default {
  async fetch(req, env, ctx) {
    const override = env.ALLOW_TEST_CLOCK === "1" ? Number(req.headers.get("x-test-now")) : NaN;
    const clock = Number.isFinite(override) && override > 0 ? new FixedClock(override) : systemClock;
    if (new URL(req.url).pathname.match(/^\/(api|admin\/api|webhook|dev)\//)) await loadSchedule(env.DB);
    return handleRequest(req, env, clock, lineClientFor(env), (p) => ctx.waitUntil(p));
  },
  async scheduled(_event, env): Promise<void> {
    await loadSchedule(env.DB);
    await runScheduler({ db: env.DB, clock: systemClock, line: lineClientFor(env), liffId: env.LIFF_ID });
  },
} satisfies ExportedHandler<Env>;
