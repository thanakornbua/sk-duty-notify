import type { Env } from "./index";

/**
 * The only seam to email. Business code never sees SMTP. The self-hosted server provides an SMTP client
 * (server/smtp.ts); on Workers there is none unless one is bound as env.EMAIL, so email rows are not sent.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** HTML alternative (sent as multipart/alternative with the text). */
  html?: string;
  /** Pinned per outbox row (from its retry key) and reused on every retry, so receivers can drop duplicates. */
  messageId: string;
}

export type EmailResult =
  | { kind: "accepted"; messageId: string }
  /** 4xx reply, connection failure or timeout. The message may or may not have been accepted. */
  | { kind: "temporary"; message: string }
  /** 5xx reply (bad address, policy rejection). Not retried. */
  | { kind: "permanent"; message: string };

export interface EmailClient {
  send(m: EmailMessage): Promise<EmailResult>;
}

/** Dev/test client: records messages, optional scripted results. */
export class FakeEmailClient implements EmailClient {
  sent: EmailMessage[] = [];
  next: EmailResult[] = [];
  async send(m: EmailMessage): Promise<EmailResult> {
    const r = this.next.shift() ?? { kind: "accepted", messageId: m.messageId };
    if (r.kind === "accepted") this.sent.push(m);
    return r;
  }
}

// Dev-only in-memory client, kept for the isolate's lifetime.
export const fakeEmail = new FakeEmailClient();

/** env.EMAIL (bound by the self-hosted server), the fake (EMAIL_CLIENT=fake, dev only), or none. */
export function emailClientFor(env: Env): EmailClient | undefined {
  return env.EMAIL ?? (env.EMAIL_CLIENT === "fake" ? fakeEmail : undefined);
}
