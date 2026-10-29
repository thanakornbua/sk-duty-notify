/**
 * Every tunable lives here: times, windows, geofence defaults, retry policy, message copy.
 * Values marked [ASSUMPTION] are unconfirmed defaults (see PLAN.md "Assumptions").
 */
export type MessageKind = "REMINDER" | "PROMPT" | "MISSED";

export const config = {
  /** Asia/Bangkok is fixed UTC+7 (no DST). Duty dates are Bangkok calendar dates. */
  tzOffsetMinutes: 7 * 60,

  /** Roster shift codes -> Bangkok wall-clock times. A row may override with explicit start/end. [ASSUMPTION] */
  shifts: {
    AM: { start: "06:30", end: "12:00" },
    PM: { start: "14:20", end: "18:00" },
  } as Record<string, { start: string; end: string }>,
  /** Max length of a custom shift code (rows with explicit start/end). */
  shiftCodeMaxLength: 12,

  /** Day-before reminder, Bangkok time on the calendar day before the duty date. [ASSUMPTION] */
  reminderTime: "16:00",
  /** Check-in window is [start - earlyGraceMinutes, end]. [ASSUMPTION] */
  earlyGraceMinutes: 15,
  /** A check-in later than start + lateAfterMinutes is recorded late. Exactly start + 30:00 is on time. [ASSUMPTION] */
  lateAfterMinutes: 30,
  /** The one "missed check-in" push goes out at start + missedAfterMinutes if still PENDING. [ASSUMPTION] */
  missedAfterMinutes: 30,
  /** Nothing is pushed between these Bangkok times; jobs wait until the end, or fail if past their deadline. */
  quietHours: { start: "21:00", end: "06:00" },

  /** Geofence defaults for new locations. Tune per location during the pilot. [ASSUMPTION] */
  defaultRadiusM: 100,
  defaultAllowedAccuracyM: 50,
  radiusRangeM: [10, 2000] as const,
  accuracyRangeM: [5, 500] as const,

  nonceTtlSeconds: 180,
  /** Per member: at most this many check-in attempts per window. Extra attempts are logged as rejected. */
  checkinRateLimit: { max: 10, windowMinutes: 5 },

  /** Raw lat/lng on check-in attempts older than this are nulled; result and distance are kept. [OPEN: Q8] */
  locationRetentionDays: 90,

  /** Anomaly flags on the admin view (flags only, never auto-reject). */
  anomaly: {
    maxSpeedKmh: 150,
    repeatedLowAccuracy: 3,
    clockSkewMinutes: 5,
  },

  linkCodeTtlMinutes: 15,

  /** Scheduler */
  batchSize: 10,
  leaseSeconds: 120,
  maxAttempts: 5,
  retryBackoffMinutes: [1, 2, 5, 10],
  retryJitterRatio: 0.2,
  unboundRecheckMinutes: 5,
  /** Real LINE client: per-request timeout. */
  lineTimeoutMs: 8000,

  /** Dashboard alert thresholds */
  heartbeatStaleMinutes: 3,

  /** Message copy. Synthetic English placeholders; final (Thai) copy is still to come from the client. */
  messages: {
    reminder: (dateLabel: string, lines: string[], url: string) =>
      `Duty reminder for ${dateLabel}:\n${lines.join("\n")}\n\nCheck-in opens ${config.earlyGraceMinutes} min before each start, ` +
      `inside the duty location only. Your duties: ${url}`,
    reminderLine: (shift: string, start: string, end: string, location: string) => `• ${shift} ${start}–${end} at ${location}`,
    prompt: (shift: string, start: string, location: string) =>
      `${shift} duty starts ${start} at ${location}. Tap Check in when you are on site.`,
    missed: (shift: string, start: string, location: string) =>
      `You have not checked in for ${shift} duty (${start}, ${location}). Check in now if you are on site.`,
    checkInLabel: "Check in",
    followReply: (url: string) =>
      `Welcome. To receive duty notices, open ${url} and enter the one-time code from your coordinator.`,
    help: (url: string) => `This chat only sends duty notices. Your duties and check-in: ${url}`,
  },

  /** Shown once on the check-in page; accepting stores members.consent_at. [OPEN: Q8 wording] */
  consentText:
    "To check in, this page reads your phone's location once, at the moment you tap Check in. " +
    "It is not tracked at any other time. The location is stored with your check-in so the duty coordinators can " +
    "verify attendance, and is deleted after 90 days.",
};
