/**
 * Every tunable lives here: times, windows, geofence defaults, retry policy, message copy.
 * Values marked [ASSUMPTION] are unconfirmed defaults (see PLAN.md "Assumptions").
 * The scheduling subset (see src/settings.ts) can be overridden on the management screen; these are its defaults.
 */
export type MessageKind = "REMINDER" | "PROMPT" | "MISSED" | "CONFIRM";
export type Lang = "th" | "en";
/** Email notifications: off, only to members not linked to LINE (when planned), or to everyone with a roster email. */
export type EmailMode = "off" | "fallback" | "all";
/** Fields of the check-in receipt email. */
export interface Receipt { member: string; duty: string; location: string; time: string; late: boolean; override: boolean; no: string }

export const config = {
  /** Shown on the credits page (/healthz). Keep in step with package.json. */
  version: "1.1.0",

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
  /** Email a receipt to the member's roster email after a successful check-in or override (no LINE quota used). */
  confirmOnCheckin: true,
  /** Language of LINE messages to members. */
  messageLanguage: "th" as Lang,
  /** Email copies of REMINDER/PROMPT/MISSED (needs SMTP, see .env.example). Links point to the member portal (/me).
   *  Receipts (CONFIRM) are always email, independent of this. */
  emailMode: "off" as EmailMode,

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

  /** Google sign-in: how long a started sign-in may take. */
  google: { stateTtlMinutes: 10 },

  /** Member portal (/me): Google sign-in with the roster email; read own records, check in from the browser. */
  portal: { sessionDays: 30, idleDays: 14, cookieName: "__Host-sdn_member" },
  /** SMTP: per-message timeout. */
  emailTimeoutMs: 15000,

  /** Admin login. */
  auth: {
    /**
     * PBKDF2-SHA256 iterations for NEW hashes (each hash records its own count, so this can be raised later).
     * 20k costs ~5 ms CPU, inside the Workers Free plan's 10 ms. On a paid plan raise to 100k (the Workers maximum).
     */
    pbkdf2Iterations: 20_000,
    minPasswordLength: 12,
    maxFailedLogins: 5,
    lockoutMinutes: 15,
    sessionHours: 12,
    idleMinutes: 120,
    cookieName: "__Host-sdn_session",
  },

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

  /** Message copy per language. Placeholders until the client confirms wording. */
  messages: {
    en: {
      reminder: (dateLabel: string, lines: string[], url: string, early: number) =>
        `Duty reminder for ${dateLabel}:\n${lines.join("\n")}\n\nCheck-in opens ${early} min before each start, ` +
        `inside the duty location only. Your duties: ${url}`,
      reminderLine: (shift: string, start: string, end: string, location: string) => `• ${shift} ${start}–${end} at ${location}`,
      prompt: (shift: string, start: string, location: string) =>
        `${shift} duty starts ${start} at ${location}. Tap Check in when you are on site.`,
      missed: (shift: string, start: string, location: string) =>
        `You have not checked in for ${shift} duty (${start}, ${location}). Check in now if you are on site.`,
      confirm: (shift: string, time: string, late: boolean, location: string) =>
        `✅ Checked in for ${shift} duty at ${time}${late ? " (late)" : " (on time)"}, ${location}.`,
      checkInLabel: "Check in",
      followReply: (url: string) =>
        `Welcome. To receive duty notices, open ${url} and sign in with your school Google account.`,
      help: (url: string) => `This chat only sends duty notices. Your duties and check-in: ${url}`,
      email: {
        reminderSubject: (dateLabel: string) => `Duty reminder: ${dateLabel}`,
        promptSubject: (shift: string, start: string) => `${shift} duty starts at ${start}`,
        missedSubject: (shift: string) => `Not checked in yet: ${shift} duty`,
        receiptSubject: (shift: string, dateLabel: string) => `Check-in receipt: ${shift} duty, ${dateLabel}`,
        receipt: (r: Receipt) => [
          "Check-in receipt", "",
          ...(r.member ? [`Member: ${r.member}`] : []),
          `Duty: ${r.duty}`, `Location: ${r.location}`,
          `Checked in: ${r.time} (${r.late ? "late" : "on time"})`,
          `Method: ${r.override ? "recorded by a coordinator" : "location check (GPS)"}`,
          `Receipt no.: ${r.no}`, "",
          "Keep this email as your record. If anything here is wrong, tell your duty coordinator and quote the receipt number.",
        ].join("\n"),
        checkInAt: (url: string) => `Check in on your duty page: ${url}`,
        footer: (url: string) => `This is an automatic message from SK Duty. Your duty records: ${url}`,
        testSubject: "SK Duty: test email",
        testBody: "Email from SK Duty works. Members will receive duty notices from this address.",
      },
    },
    th: {
      reminder: (dateLabel: string, lines: string[], url: string, early: number) =>
        `แจ้งเตือนเวร${dateLabel}\n${lines.join("\n")}\n\nเช็กอินได้ก่อนเวลาเริ่ม ${early} นาที ` +
        `และต้องอยู่ในพื้นที่เวรเท่านั้น ดูเวรของคุณ: ${url}`,
      reminderLine: (shift: string, start: string, end: string, location: string) => `• ${shift} ${start}–${end} น. ที่ ${location}`,
      prompt: (shift: string, start: string, location: string) =>
        `เวร ${shift} เริ่ม ${start} น. ที่ ${location} กด "เช็กอิน" เมื่อถึงจุดเวรแล้ว`,
      missed: (shift: string, start: string, location: string) =>
        `คุณยังไม่ได้เช็กอินเวร ${shift} (${start} น., ${location}) หากอยู่ที่จุดเวรแล้ว กดเช็กอินได้เลย`,
      confirm: (shift: string, time: string, late: boolean, location: string) =>
        `✅ เช็กอินเวร ${shift} สำเร็จ เวลา ${time} น.${late ? " (สาย)" : " (ตรงเวลา)"} ที่ ${location}`,
      checkInLabel: "เช็กอิน",
      followReply: (url: string) =>
        `ยินดีต้อนรับ หากต้องการรับการแจ้งเตือนเวร กรุณาเปิด ${url} แล้วเข้าสู่ระบบด้วยบัญชี Google ของโรงเรียน`,
      help: (url: string) => `แชตนี้ใช้ส่งการแจ้งเตือนเวรเท่านั้น ดูเวรและเช็กอินได้ที่ ${url}`,
      email: {
        reminderSubject: (dateLabel: string) => `แจ้งเตือนเวร${dateLabel}`,
        promptSubject: (shift: string, start: string) => `เวร ${shift} เริ่ม ${start} น.`,
        missedSubject: (shift: string) => `ยังไม่ได้เช็กอินเวร ${shift}`,
        receiptSubject: (shift: string, dateLabel: string) => `ใบยืนยันเช็กอิน: เวร ${shift} ${dateLabel}`,
        receipt: (r: Receipt) => [
          "ใบยืนยันการเช็กอิน", "",
          ...(r.member ? [`สมาชิก: ${r.member}`] : []),
          `เวร: ${r.duty} น.`, `จุดเวร: ${r.location}`,
          `เช็กอินเวลา: ${r.time} น. (${r.late ? "สาย" : "ตรงเวลา"})`,
          `วิธี: ${r.override ? "บันทึกโดยผู้ดูแล" : "ตรวจตำแหน่ง (GPS)"}`,
          `เลขที่: ${r.no}`, "",
          "เก็บอีเมลนี้ไว้เป็นหลักฐาน หากข้อมูลไม่ถูกต้อง แจ้งผู้ดูแลเวรพร้อมเลขที่ใบยืนยัน",
        ].join("\n"),
        checkInAt: (url: string) => `เช็กอินได้ที่หน้าเวรของคุณ: ${url}`,
        footer: (url: string) => `ข้อความอัตโนมัติจาก SK Duty ดูประวัติเวรของคุณได้ที่ ${url}`,
        testSubject: "SK Duty: ทดสอบอีเมล",
        testBody: "ระบบส่งอีเมลของ SK Duty ใช้งานได้ สมาชิกจะได้รับการแจ้งเตือนเวรจากที่อยู่นี้",
      },
    },
  },

  /** Shown once on the check-in page; accepting stores members.consent_at. [OPEN: Q8 wording] */
  consentText: {
    en: "To check in, this page reads your phone's location once, at the moment you tap Check in. " +
      "It is not tracked at any other time. The location is stored with your check-in so the duty coordinators can " +
      "verify attendance, and is deleted after 90 days.",
    th: "เมื่อกดเช็กอิน หน้านี้จะอ่านตำแหน่งของโทรศัพท์หนึ่งครั้ง ณ เวลาที่กดเท่านั้น และไม่มีการติดตามตำแหน่งในเวลาอื่น " +
      "ตำแหน่งจะถูกบันทึกพร้อมการเช็กอินเพื่อให้ผู้ดูแลเวรตรวจสอบการมาปฏิบัติหน้าที่ และจะถูกลบหลังจาก 90 วัน",
  },
};
