/** The only seam to LINE. Business code never sees HTTP. */
export interface LineMessage {
  type: string;
  [k: string]: unknown;
}

export interface PushRequest {
  to: string;
  messages: LineMessage[];
  /** Sent as X-Line-Retry-Key. Pinned per outbox row and reused on every retry. */
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

/** Result of LINE's ID token verify endpoint. `userId` is the token's `sub`. */
export type VerifyResult = { ok: true; userId: string } | { ok: false; reason: string };

export interface LineClient {
  push(req: PushRequest): Promise<PushResult>;
  /** Reply to a webhook event. Best effort: the caller has already committed state and ignores failures. */
  reply(replyToken: string, messages: LineMessage[]): Promise<{ ok: boolean }>;
  /** Verify a LIFF ID token with LINE. Throws if LINE cannot be reached (caller answers 503). */
  verifyIdToken(idToken: string): Promise<VerifyResult>;
}
