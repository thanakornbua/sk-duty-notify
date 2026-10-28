import type { Clock } from "./clock";
import { config, type ActionKind } from "./config";
import { buildMessages } from "./messages";
import { WHAT } from "./webhook";
import { bangkokDateOf, bangkokInstant } from "./time";

const MIN = 60_000;
const KINDS: ActionKind[] = ["ACK", "AM", "PM"];

/** What the app would send for one duty day, built with the same code the scheduler uses. Nothing is sent. */
export async function buildPreview(db: D1Database, clock: Clock) {
  const today = bangkokDateOf(clock.now());
  const next = await db.prepare(
    "SELECT MIN(duty_date) d FROM assignments WHERE is_active = 1 AND withdrawn = 0 AND duty_date >= ?",
  ).bind(today).first<{ d: string | null }>();

  let dutyDate = next?.d ?? today;
  let source = "active roster";
  let roster: { position: string; label: string }[] = [];
  if (next?.d) {
    roster = (await db.prepare(
      `SELECT a.position, p.label FROM assignments a JOIN people p ON p.staff_id = a.staff_id
       WHERE a.duty_date = ? AND a.is_active = 1 AND a.withdrawn = 0 ORDER BY a.position`,
    ).bind(dutyDate).all<{ position: string; label: string }>()).results;
  } else {
    source = "built-in sample (no upcoming roster)";
    roster = config.positions.map((position, i) => ({ position, label: `Sample Person ${i + 1}` }));
  }

  const R = config.messages.replies;
  const am = WHAT.AM;
  return {
    dutyDate, source,
    schedule: KINDS.map((kind, idx) => {
      const send = config.sendTimes[kind], cut = config.cutoffs[kind];
      const sendAt = bangkokInstant(dutyDate, send.time, send.dayOffset);
      const input = { kind, dutyDate, actionId: 101 + idx, revision: 1, roster };
      return {
        kind,
        sendAt,
        lateAfterAt: sendAt + config.lateAfterMinutes * MIN,
        cutoffAt: bangkokInstant(dutyDate, cut.time, cut.dayOffset),
        messages: buildMessages({ ...input, phase: "INITIAL" }),
        reminderAfterMinutes: config.reminderOffsetMinutes,
        reminder: buildMessages({ ...input, phase: "REMINDER" }),
      };
    }),
    replies: [
      { scenario: "Pressed in time", text: R.completed(am, false) },
      { scenario: "Pressed more than 30 min after the push (still accepted until the cutoff)", text: R.completed(am, true) },
      { scenario: "Pressed again", text: R.already(am, false) },
      { scenario: "Pressed again after a late check-in", text: R.already(am, true) },
      { scenario: "Button forwarded to someone else, or pressed by an unlinked account", text: R.notYours },
      { scenario: "Pressed before the window opened", text: R.notOpen(am) },
      { scenario: "Pressed after the cutoff", text: R.closed(am) },
      { scenario: "Old button from a superseded version", text: R.stale },
      { scenario: "Button that no longer exists", text: R.unknownButton },
      { scenario: "Linking: valid code typed in the private chat", text: R.bound("S001") },
      { scenario: "Linking: wrong, expired or used code", text: R.bindFailed },
      { scenario: "Linking: this LINE account is already linked", text: R.alreadyBound },
      { scenario: "Anything else typed in the private chat", text: R.help },
    ],
    notes: {
      lateAfterMinutes: config.lateAfterMinutes,
      reminderOffsetMinutes: config.reminderOffsetMinutes,
    },
  };
}
