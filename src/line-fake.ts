import type { LineClient, LineMessage, PushRequest, PushResult } from "./line";

export type Failure =
  | { kind: "timeout" }
  /** LINE accepts the push but the response is lost. */
  | { kind: "timeout_after_accept" }
  | { kind: "rate_limited"; retryAfterSeconds?: number }
  | { kind: "server_error"; status?: number }
  | { kind: "client_error"; status?: number; message?: string }
  /** 409 without having accepted anything here; optionally carries an accepted request id. */
  | { kind: "conflict"; acceptedRequestId?: string };

/** In-memory LINE. Mirrors the retry-key contract: a key already accepted gets 409 + the original request id. */
export class FakeLineClient implements LineClient {
  /** Unique accepted pushes (one per retry key). */
  readonly sent: { to: string; messages: LineMessage[]; retryKey: string; requestId: string }[] = [];
  /** Every call, including failed ones. */
  readonly calls: PushRequest[] = [];
  /** Persistent per-request rule, checked before the one-shot script. */
  rule?: (req: PushRequest) => Failure | undefined;
  /** Webhook replies, in order. */
  readonly replies: { replyToken: string; messages: LineMessage[] }[] = [];
  /** Optional spy run at reply time (lets tests assert state was committed before replying). */
  onReply?: (replyToken: string) => void | Promise<void>;
  private script: Failure[] = [];
  private byKey = new Map<string, string>();

  /** Queue one-shot failures, consumed in call order. */
  inject(...failures: Failure[]) { this.script.push(...failures); }

  async push(req: PushRequest): Promise<PushResult> {
    this.calls.push(req);
    const f = this.rule?.(req) ?? this.script.shift();
    if (f) {
      switch (f.kind) {
        case "timeout": return { kind: "timeout" };
        case "timeout_after_accept": this.accept(req); return { kind: "timeout" };
        case "rate_limited": return { kind: "rate_limited", retryAfterSeconds: f.retryAfterSeconds };
        case "server_error": return { kind: "server_error", status: f.status ?? 503 };
        case "client_error": return { kind: "client_error", status: f.status ?? 400, message: f.message ?? "bad request" };
        case "conflict": return { kind: "duplicate", acceptedRequestId: f.acceptedRequestId };
      }
    }
    const existing = this.byKey.get(req.retryKey);
    if (existing) return { kind: "duplicate", acceptedRequestId: existing };
    return { kind: "accepted", requestId: this.accept(req) };
  }

  async reply(replyToken: string, messages: LineMessage[]) {
    await this.onReply?.(replyToken);
    this.replies.push({ replyToken, messages });
    return { ok: true };
  }

  private accept(req: PushRequest): string {
    const existing = this.byKey.get(req.retryKey);
    if (existing) return existing;
    const requestId = `fake-req-${this.sent.length + 1}`;
    this.byKey.set(req.retryKey, requestId);
    this.sent.push({ to: req.to, messages: req.messages, retryKey: req.retryKey, requestId });
    return requestId;
  }
}
