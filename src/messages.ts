import { config, type MessageKind } from "./config";
import type { LineMessage } from "./line";
import { bangkokTimeOf, dateLabel } from "./time";

export const liffUrl = (liffId: string, path = "checkin") => `https://liff.line.me/${liffId}/${path}`;

export interface DutyInfo { shift: string; start_at: number; end_at: number; location: string; checked_in_at?: number | null; late?: number | null }

/** LINE buttons template limits (no title, no image). */
export const LIMITS = { buttonsText: 160, label: 20, altText: 400, uri: 1000, text: 5000 };

const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + "…");

/**
 * Copy in config.messageLanguage. The URI carries no duty id or secret: the check-in page finds the duty
 * server-side from the verified ID token and the server clock.
 */
export function buildMessages(kind: MessageKind, dutyDate: string, duties: DutyInfo[], liffId: string): LineMessage[] {
  const lang = config.messageLanguage;
  const M = config.messages[lang];
  const url = liffUrl(liffId);
  if (kind === "REMINDER") {
    const lines = duties.map((d) => M.reminderLine(d.shift, bangkokTimeOf(d.start_at), bangkokTimeOf(d.end_at), d.location));
    return [{ type: "text", text: clip(M.reminder(dateLabel(dutyDate, lang), lines, url, config.earlyGraceMinutes), LIMITS.text) }];
  }
  const d = duties[0];
  if (kind === "CONFIRM") {
    return [{ type: "text", text: clip(M.confirm(d.shift, bangkokTimeOf(d.checked_in_at ?? d.start_at), d.late === 1, d.location), LIMITS.text) }];
  }
  const text = (kind === "PROMPT" ? M.prompt : M.missed)(d.shift, bangkokTimeOf(d.start_at), d.location);
  return [{
    type: "template",
    altText: clip(text, LIMITS.altText),
    template: {
      type: "buttons",
      text: clip(text, LIMITS.buttonsText),
      actions: [{ type: "uri", label: clip(M.checkInLabel, LIMITS.label), uri: url }],
    },
  }];
}
