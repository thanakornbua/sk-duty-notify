/**
 * EmailClient over SMTP (nodemailer), for the self-hosted server. Works with Google Workspace:
 *   - smtp.gmail.com:465 with an app password of a sending account, or
 *   - smtp-relay.gmail.com:587 (Workspace SMTP relay, allowed by IP or with SMTP auth).
 * Configuration: SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_RATE_PER_SECOND,
 * SMTP_REQUIRE_TLS (default 1: STARTTLS is required on a non-TLS port; 0 only for a relay on a trusted local network).
 */
import { createTransport } from "nodemailer";
import { config } from "../src/config";
import type { EmailClient, EmailMessage, EmailResult } from "../src/email";

export function smtpFromEnv(env: NodeJS.ProcessEnv): EmailClient | undefined {
  if (!env.SMTP_HOST) return undefined;
  const port = Number(env.SMTP_PORT ?? 587);
  const secure = env.SMTP_SECURE ? env.SMTP_SECURE === "1" : port === 465;
  const from = env.SMTP_FROM || env.SMTP_USER;
  if (!from) throw new Error("SMTP_FROM (or SMTP_USER) is required when SMTP_HOST is set");
  const transport = createTransport({
    host: env.SMTP_HOST, port, secure, requireTLS: !secure && env.SMTP_REQUIRE_TLS !== "0",
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS ?? "" } : undefined,
    pool: true, maxConnections: 2,
    // Stay under provider limits on a wave (e.g. 150 prompts at 06:30).
    rateDelta: 1000, rateLimit: Number(env.SMTP_RATE_PER_SECOND ?? 5),
    connectionTimeout: config.emailTimeoutMs, greetingTimeout: config.emailTimeoutMs, socketTimeout: config.emailTimeoutMs,
  });
  return {
    async send(m: EmailMessage): Promise<EmailResult> {
      try {
        const info = await transport.sendMail({
          from, to: m.to, subject: m.subject, text: m.text, html: m.html, messageId: m.messageId,
          headers: { "Auto-Submitted": "auto-generated" },
        });
        return { kind: "accepted", messageId: info.messageId ?? m.messageId };
      } catch (e) {
        const err = e as { responseCode?: number; message?: string };
        const message = err.message ?? String(e);
        return err.responseCode && err.responseCode >= 500 ? { kind: "permanent", message } : { kind: "temporary", message };
      }
    },
  };
}
