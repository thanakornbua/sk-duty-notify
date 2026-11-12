import { config, type MessageKind } from "./config";
import type { LineMessage } from "./line";
import { renderHtml, renderText, type EmailDoc } from "./email-render";
import { shiftLabel } from "./settings";
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
    const lines = duties.map((d) => M.reminderLine(shiftLabel(d.shift), bangkokTimeOf(d.start_at), bangkokTimeOf(d.end_at), d.location));
    return [{ type: "text", text: clip(M.reminder(dateLabel(dutyDate, lang), lines, url, config.earlyGraceMinutes), LIMITS.text) }];
  }
  const d = duties[0];
  if (kind === "CONFIRM") {
    return [{ type: "text", text: clip(M.confirm(shiftLabel(d.shift), bangkokTimeOf(d.checked_in_at ?? d.start_at), d.late === 1, d.location), LIMITS.text) }];
  }
  const text = (kind === "PROMPT" ? M.prompt : M.missed)(shiftLabel(d.shift), bangkokTimeOf(d.start_at), d.location);
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

/** Email of a message (plain text + HTML), in config.messageLanguage. CONFIRM is the check-in receipt. */
export function buildEmail(
  kind: MessageKind, dutyDate: string, duties: DutyInfo[], publicUrl: string, member?: { label: string; staff_code: string },
): { subject: string; text: string; html: string } {
  const lang = config.messageLanguage;
  const M = config.messages[lang];
  const E = M.email;
  const L = E.label;
  const url = portalUrl(publicUrl);
  const at = (ms: number) => `${bangkokTimeOf(ms)}${E.timeSuffix}`;
  const span = (d: DutyInfo) => `${bangkokTimeOf(d.start_at)}–${bangkokTimeOf(d.end_at)}${E.timeSuffix}`;
  const date = dateLabel(dutyDate, lang).trim();
  const base = {
    lang, linkHint: E.linkHint, emblemUrl: `${publicUrl.replace(/\/+$/, "")}/brand/emblem-96.png`,
    footer: { note: E.autoNote, linkLabel: E.ctaDuties, url },
  };
  let doc: EmailDoc;
  if (kind === "REMINDER") {
    doc = {
      ...base, subject: E.reminderSubject(dateLabel(dutyDate, lang)), title: E.reminderTitle(dateLabel(dutyDate, lang)),
      preheader: duties.map((d) => `${shiftLabel(d.shift)} ${span(d)}`).join(" · "),
      intro: E.reminderIntro,
      list: duties.map((d) => `${shiftLabel(d.shift)} · ${span(d)} · ${d.location}`),
      note: E.windowNote(config.earlyGraceMinutes),
      cta: { label: E.ctaDuties, url },
    };
  } else {
    const d = duties[0];
    const shift = shiftLabel(d.shift);
    if (kind === "CONFIRM") {
      const late = d.late === 1;
      doc = {
        ...base, subject: E.receiptSubject(shift, date), title: E.receiptTitle,
        preheader: `${shift} · ${at(d.checked_in_at ?? d.start_at)} · ${late ? E.late : E.onTime}`,
        badge: { text: late ? E.late : E.onTime, tone: late ? "magenta" : "green" },
        rows: [
          ...(member ? [[L.member, `${member.label} (${member.staff_code})`] as [string, string]] : []),
          [L.duty, `${shift} · ${span(d)}`], [L.date, date], [L.location, d.location],
          [L.checkedIn, `${at(d.checked_in_at ?? d.start_at)} (${late ? E.late : E.onTime})`],
          [L.method, d.source === "override" ? E.override : E.gps],
          [L.receiptNo, receiptNo(d)],
        ],
        note: E.keepNote,
        cta: { label: E.ctaRecord, url },
      };
    } else {
      const start = bangkokTimeOf(d.start_at);
      const prompt = kind === "PROMPT";
      doc = {
        ...base,
        subject: prompt ? E.promptSubject(shift, start) : E.missedSubject(shift),
        title: prompt ? E.promptTitle(shift, start) : E.missedTitle(shift),
        preheader: `${shift} · ${span(d)} · ${d.location}`,
        intro: (prompt ? M.prompt : M.missed)(shift, start, d.location),
        rows: [[L.duty, `${shift} · ${span(d)}`], [L.date, date], [L.location, d.location],
          [L.window, `${bangkokTimeOf(d.start_at - config.earlyGraceMinutes * 60_000)}–${bangkokTimeOf(d.end_at)}${E.timeSuffix}`]],
        cta: { label: E.ctaCheckIn, url },
      };
    }
  }
  return { subject: doc.subject, text: renderText(doc), html: renderHtml(doc) };
}

/** The Settings page's test email, in the same layout. */
export function buildTestEmail(publicUrl: string): { subject: string; text: string; html: string } {
  const lang = config.messageLanguage;
  const E = config.messages[lang].email;
  const url = portalUrl(publicUrl);
  const doc: EmailDoc = {
    lang, subject: E.testSubject, title: E.testTitle, preheader: E.testBody, intro: E.testBody,
    badge: { text: "SMTP OK", tone: "blue" }, emblemUrl: `${publicUrl.replace(/\/+$/, "")}/brand/emblem-96.png`,
    footer: { note: E.autoNote, linkLabel: E.ctaDuties, url },
  };
  return { subject: doc.subject, text: renderText(doc), html: renderHtml(doc) };
}
