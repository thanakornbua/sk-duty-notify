/** The only seam to LINE. The scheduler never sees HTTP. */
export interface LineMessage {
  type: string;
  [k: string]: unknown;
}

export interface PushRequest {
  to: string;
  messages: LineMessage[];
  /** Sent as X-Line-Retry-Key. Pinned per job and reused on every retry. */
  retryKey: string;
}

export type PushResult =
  | { kind: "accepted"; requestId: string }
  /** 409: this retry key was already accepted. LINE returns the accepted request id when it knows it. */
  | { kind: "duplicate"; acceptedRequestId?: string }
  | { kind: "rate_limited"; retryAfterSeconds?: number }
  | { kind: "server_error"; status: number }
  /** No usable response. The push may or may not have been accepted. */
  | { kind: "timeout" }
  | { kind: "client_error"; status: number; message: string };

export interface LineClient {
  push(req: PushRequest): Promise<PushResult>;
  /** Reply to a webhook event. Best effort: the caller has already committed state and ignores failures. */
  reply(replyToken: string, messages: LineMessage[]): Promise<{ ok: boolean }>;
}
