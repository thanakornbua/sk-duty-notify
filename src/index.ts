import { handleRequest } from "./app";
import { FixedClock, systemClock } from "./clock";
import { FakeLineClient } from "./line-fake";
import { runScheduler } from "./scheduler";

export interface Env {
  DB: D1Database;
  LINE_CHANNEL_SECRET?: string;
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  ADMIN_TOKEN?: string;
  /** "fake" = dev only: jobs are marked API_ACCEPTED against an in-memory client, nothing reaches LINE. */
  LINE_CLIENT?: string;
  /** Dev/perf only: lets requests set the clock with x-test-now and enables /dev/* routes. Never set in production. */
  ALLOW_TEST_CLOCK?: string;
}

// Dev-only in-memory client, kept for the isolate's lifetime.
const fake = new FakeLineClient();

export default {
  fetch(req, env) {
    const override = env.ALLOW_TEST_CLOCK === "1" ? Number(req.headers.get("x-test-now")) : NaN;
    const clock = Number.isFinite(override) && override > 0 ? new FixedClock(override) : systemClock;
    return handleRequest(req, env, clock, env.LINE_CLIENT === "fake" ? fake : undefined);
  },
  async scheduled(_event, env): Promise<void> {
    // The real LINE client arrives in Phase 6. Until then, without LINE_CLIENT=fake the scheduler
    // plans, expires and writes its heartbeat but sends nothing.
    await runScheduler({ db: env.DB, clock: systemClock, line: env.LINE_CLIENT === "fake" ? fake : undefined });
  },
} satisfies ExportedHandler<Env>;
