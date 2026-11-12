import { config, type MessageKind } from "./config";
import type { LineMessage } from "./line";
import { bangkokTimeOf, dateLabel } from "./time";

export const liffUrl = (liffId: string, path = "checkin") => `https://liff.line.me/${liffId}/${path}`;

export interface DutyInfo {
  shift: string; start_at: number; end_at: number; location: string; checked_in_at?: number | null; late?: number | null;
  id?: number; source?: string | null;
}

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

/** Member portal page linked from emails (check-in works there with a Google session). */
export const portalUrl = (publicUrl: string) => `${publicUrl.replace(/\/+$/, "")}/me`;

/** Receipt number: duty id + check-in time, so a member can quote it to a coordinator. */
export const receiptNo = (d: DutyInfo) => `SKD-${d.id ?? 0}-${(d.checked_in_at ?? 0).toString(36).toUpperCase()}`;

/** Email copy of a message, in config.messageLanguage. Plain text. CONFIRM is the check-in receipt. */
export function buildEmail(
  kind: MessageKind, dutyDate: string, duties: DutyInfo[], publicUrl: string, member?: { label: string; staff_code: string },
): { subject: string; text: string } {
  const lang = config.messageLanguage;
  const M = config.messages[lang];
  const E = M.email;
  const url = portalUrl(publicUrl);
  const foot = `\n\n--\n${E.footer(url)}`;
  if (kind === "REMINDER") {
    const label = dateLabel(dutyDate, lang);
    const lines = duties.map((d) => M.reminderLine(d.shift, bangkokTimeOf(d.start_at), bangkokTimeOf(d.end_at), d.location));
    return { subject: E.reminderSubject(label), text: M.reminder(label, lines, url, config.earlyGraceMinutes) + foot };
  }
  const d = duties[0];
  if (kind === "CONFIRM") {
    const label = dateLabel(dutyDate, lang);
    return {
      subject: E.receiptSubject(d.shift, label),
      text: E.receipt({
        member: member ? `${member.label} (${member.staff_code})` : "",
        duty: `${d.shift} ${bangkokTimeOf(d.start_at)}–${bangkokTimeOf(d.end_at)}, ${label}`,
        location: d.location,
        time: bangkokTimeOf(d.checked_in_at ?? d.start_at),
        late: d.late === 1,
        override: d.source === "override",
        no: receiptNo(d),
      }) + foot,
    };
  }
  const start = bangkokTimeOf(d.start_at);
  return kind === "PROMPT"
    ? { subject: E.promptSubject(d.shift, start), text: `${M.prompt(d.shift, start, d.location)}\n\n${E.checkInAt(url)}${foot}` }
    : { subject: E.missedSubject(d.shift), text: `${M.missed(d.shift, start, d.location)}\n\n${E.checkInAt(url)}${foot}` };
}
