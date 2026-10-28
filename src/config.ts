/**
 * Single config file: send times, offsets, cutoffs, batch size, message copy.
 * Times of day are Asia/Bangkok wall-clock; instants are computed from them in UTC.
 * Cutoffs are UNCONFIRMED defaults (see PLAN.md Assumptions).
 */
export const config = {
  timezone: "Asia/Bangkok",
  /** Fixed UTC offset for Asia/Bangkok (no DST). Minutes. */
  tzOffsetMinutes: 7 * 60,
  dutyPerDay: 10,
  /** Valid positions (rows in the roster). Synthetic. */
  positions: ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10"],

  /** Initial send times, Bangkok wall clock. ACK is on the calendar day BEFORE the duty day. */
  sendTimes: {
    ACK: { dayOffset: -1, time: "16:00" },
    AM: { dayOffset: 0, time: "06:30" },
    PM: { dayOffset: 0, time: "14:20" },
  },
  /** Cutoffs on the duty day, Bangkok wall clock. ACK cutoff = AM send time on the duty day. */
  cutoffs: {
    ACK: { dayOffset: 0, time: "06:30" },
    AM: { dayOffset: 0, time: "12:00" },
    PM: { dayOffset: 0, time: "18:00" },
  },

  reminderOffsetMinutes: 30,
  /** Check-in later than start + this is recorded as late (still accepted until cutoff). */
  lateAfterMinutes: 30,

  batchSize: 10,
  leaseSeconds: 120,
  maxAttempts: 5,
  /** Recheck an unbound recipient this often until the job deadline. */
  unboundRecheckMinutes: 5,
  retryBackoffMinutes: [1, 2, 5, 10],
  retryJitterRatio: 0.2,

  bindingCodeTtlMinutes: 15,

  /** Dashboard thresholds. */
  heartbeatStaleMinutes: 3,
  overdueQueueMinutes: 3,
  failedJobsLimit: 50,
  /** After this Bangkok time, a missing roster for TOMORROW is a high alert (the ACK goes out at 16:00). */
  missingTomorrowHighAfter: "12:00",

  messages: {
    ack: (dateLabel: string, rosterLines: string) =>
      `Duty roster for ${dateLabel}\n${rosterLines}\nPlease acknowledge.`,
    checkInAm: (dateLabel: string) => `AM duty check-in, ${dateLabel}`,
    checkInPm: (dateLabel: string) => `PM duty check-in, ${dateLabel}`,
    reminder: (what: string) => `Reminder: ${what} is still pending.`,
    buttons: { ACK: "Acknowledge", AM: "Check-In AM", PM: "Check-In PM" },
    replies: {
      completed: (what: string, late: boolean) => `${what} recorded${late ? " (late)" : ""}. Thank you.`,
      already: (what: string, late: boolean) => `${what} was already recorded${late ? " (late)" : ""}.`,
      notYours: "This button belongs to someone else.",
      notOpen: (what: string) => `${what} is not open yet.`,
      closed: (what: string) => `${what} is closed.`,
      stale: "This button is out of date.",
      unknownButton: "This button is no longer valid.",
      bound: (staffId: string) => `Linked to ${staffId}. You will receive duty notifications here.`,
      bindFailed: "That code is not valid. Ask an admin for a new one.",
      alreadyBound: "This LINE account is already linked to another staff ID.",
      help: "Send the 8-character code from your admin to link this account.",
    },
  },
} as const;

/** Code alphabet: no I, L, O, 0, 1. */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 8;

export type ActionKind = "ACK" | "AM" | "PM";
