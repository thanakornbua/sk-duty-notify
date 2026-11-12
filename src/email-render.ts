/**
 * Email layout: one structured document rendered twice, as plain text and as HTML (multipart/alternative).
 * The HTML is table-based with inline styles (what Gmail, Outlook and phone mail apps render reliably), in the app's
 * Carbon look: white card on gray, IBM Plex Sans (Tahoma fallback for Thai), blue #0f62fe for the one button, the school
 * emblem in the header (loaded from PUBLIC_URL, like any remote image). Every dynamic value is HTML-escaped.
 */

export interface EmailDoc {
  lang: "th" | "en";
  subject: string;
  /** Inbox preview line (hidden in the body). */
  preheader: string;
  title: string;
  badge?: { text: string; tone: "green" | "magenta" | "blue" };
  intro?: string;
  /** Bullet list (e.g. the day's duties). */
  list?: string[];
  /** Label/value table (receipt details). */
  rows?: [string, string][];
  note?: string;
  cta?: { label: string; url: string };
  /** Shown under the button, before the link itself. */
  linkHint?: string;
  footer: { note: string; linkLabel: string; url: string };
  emblemUrl?: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const FONT = "'IBM Plex Sans','IBM Plex Sans Thai',Tahoma,'Segoe UI',Helvetica,Arial,sans-serif";
const C = { text: "#161616", text2: "#525252", helper: "#6f6f6f", bg: "#f4f4f4", card: "#ffffff", border: "#e0e0e0", blue: "#0f62fe" };
const TONE = {
  green: { bg: "#a7f0ba", fg: "#0e6027" },
  magenta: { bg: "#ffd6e8", fg: "#9f1853" },
  blue: { bg: "#d0e2ff", fg: "#0043ce" },
};

export function renderText(d: EmailDoc): string {
  const out: string[] = [d.title];
  if (d.badge) out.push(`[${d.badge.text}]`);
  if (d.intro) out.push("", d.intro);
  if (d.list?.length) out.push("", ...d.list.map((l) => `• ${l}`));
  if (d.rows?.length) out.push("", ...d.rows.map(([k, v]) => `${k}: ${v}`));
  if (d.note) out.push("", d.note);
  if (d.cta) out.push("", `${d.cta.label}: ${d.cta.url}`);
  out.push("", "--", `${d.footer.note} ${d.footer.linkLabel}: ${d.footer.url}`);
  return out.join("\n");
}

export function renderHtml(d: EmailDoc): string {
  const p = (text: string, style = "") =>
    `<p style="margin:0 0 16px;font-family:${FONT};font-size:14px;line-height:22px;color:${C.text};${style}">${esc(text)}</p>`;
  const badge = d.badge
    ? `<p style="margin:0 0 16px;"><span style="display:inline-block;padding:2px 10px;border-radius:12px;background:${TONE[d.badge.tone].bg};` +
      `color:${TONE[d.badge.tone].fg};font-family:${FONT};font-size:13px;line-height:20px;font-weight:600;">${esc(d.badge.text)}</span></p>`
    : "";
  const list = d.list?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;border-collapse:collapse;">` +
      d.list.map((l) => `<tr><td style="padding:10px 12px;border-left:3px solid ${C.blue};background:${C.bg};font-family:${FONT};font-size:14px;line-height:20px;color:${C.text};">${esc(l)}</td></tr>` +
        `<tr><td style="height:6px;line-height:6px;font-size:0;">&nbsp;</td></tr>`).join("") +
      `</table>`
    : "";
  const rows = d.rows?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border-collapse:collapse;">` +
      d.rows.map(([k, v]) => `<tr>` +
        `<td valign="top" style="padding:10px 12px 10px 0;border-bottom:1px solid ${C.border};width:38%;font-family:${FONT};font-size:13px;line-height:20px;color:${C.text2};">${esc(k)}</td>` +
        `<td valign="top" style="padding:10px 0;border-bottom:1px solid ${C.border};font-family:${FONT};font-size:14px;line-height:20px;color:${C.text};font-weight:600;">${esc(v)}</td></tr>`).join("") +
      `</table>`
    : "";
  const cta = d.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 16px;"><tr><td bgcolor="${C.blue}" style="background:${C.blue};">` +
      `<a href="${esc(d.cta.url)}" style="display:inline-block;padding:13px 40px 13px 16px;font-family:${FONT};font-size:14px;line-height:20px;color:#ffffff;text-decoration:none;">${esc(d.cta.label)} &rarr;</a>` +
      `</td></tr></table>` +
      (d.linkHint ? `<p style="margin:0;font-family:${FONT};font-size:12px;line-height:18px;color:${C.helper};">${esc(d.linkHint)}<br>` +
        `<a href="${esc(d.cta.url)}" style="color:${C.blue};word-break:break-all;">${esc(d.cta.url)}</a></p>` : "")
    : "";
  const emblem = d.emblemUrl
    ? `<img src="${esc(d.emblemUrl)}" width="36" height="36" alt="" style="display:inline-block;vertical-align:middle;border:0;outline:none;">`
    : "";
  return `<!doctype html>
<html lang="${d.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(d.subject)}</title>
</head>
<body style="margin:0;padding:0;background:${C.bg};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.bg};">${esc(d.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
<tr><td style="padding:0 0 16px;">${emblem}<span style="display:inline-block;vertical-align:middle;padding-left:${emblem ? 10 : 0}px;font-family:${FONT};font-size:16px;line-height:24px;font-weight:600;color:${C.text};">SK Duty</span></td></tr>
<tr><td style="background:${C.card};border-top:4px solid ${C.blue};padding:28px 28px 20px;">
<h1 style="margin:0 0 12px;font-family:${FONT};font-size:22px;line-height:30px;font-weight:400;color:${C.text};">${esc(d.title)}</h1>
${badge}${d.intro ? p(d.intro) : ""}${list}${rows}${d.note ? p(d.note, `color:${C.text2};font-size:13px;line-height:20px;`) : ""}${cta}
</td></tr>
<tr><td style="padding:16px 4px 0;font-family:${FONT};font-size:12px;line-height:18px;color:${C.helper};">
${esc(d.footer.note)} <a href="${esc(d.footer.url)}" style="color:${C.helper};text-decoration:underline;">${esc(d.footer.linkLabel)}</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
