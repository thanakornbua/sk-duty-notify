import { config } from "./config";
import type { LineClient, LineMessage, PushRequest, PushResult, VerifyResult } from "./line";

const API = "https://api.line.me";

/** Real LINE client. Only used when the access token and LINE Login channel id are configured. */
export class HttpLineClient implements LineClient {
  // The default must call the global fetch unbound: in Workers, `this.fetchFn(...)` on the native fetch throws
  // "Illegal invocation".
  constructor(private accessToken: string, private loginChannelId: string,
              private fetchFn: typeof fetch = (input, init) => fetch(input, init)) {}

  async push(req: PushRequest): Promise<PushResult> {
    let res: Response;
    try {
      res = await this.fetchFn(`${API}/v2/bot/message/push`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          "content-type": "application/json",
          "x-line-retry-key": req.retryKey,
        },
        body: JSON.stringify({ to: req.to, messages: req.messages }),
        signal: AbortSignal.timeout(config.lineTimeoutMs),
      });
    } catch {
      return { kind: "timeout" };
    }
    const requestId = res.headers.get("x-line-request-id") ?? "";
    if (res.ok) return { kind: "accepted", requestId };
    if (res.status === 409) {
      return { kind: "duplicate", acceptedRequestId: res.headers.get("x-line-accepted-request-id") ?? undefined };
    }
    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after"));
      return { kind: "rate_limited", retryAfterSeconds: Number.isFinite(ra) && ra > 0 ? ra : undefined };
    }
    if (res.status >= 500) return { kind: "server_error", status: res.status };
    const body = await res.text().catch(() => "");
    return { kind: "client_error", status: res.status, message: body.slice(0, 300) };
  }

  async reply(replyToken: string, messages: LineMessage[]) {
    try {
      const res = await this.fetchFn(`${API}/v2/bot/message/reply`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ replyToken, messages }),
        signal: AbortSignal.timeout(config.lineTimeoutMs),
      });
      return { ok: res.ok };
    } catch {
      return { ok: false };
    }
  }

  async verifyIdToken(idToken: string): Promise<VerifyResult> {
    const res = await this.fetchFn(`${API}/oauth2/v2.1/verify`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id_token: idToken, client_id: this.loginChannelId }),
      signal: AbortSignal.timeout(config.lineTimeoutMs),
    });
    if (res.status >= 500) throw new Error(`LINE verify ${res.status}`);
    if (!res.ok) return { ok: false, reason: "invalid_token" };
    const body = (await res.json()) as { sub?: string; aud?: string };
    // LINE checks aud against client_id; checking again costs nothing.
    if (typeof body.sub !== "string" || body.aud !== this.loginChannelId) return { ok: false, reason: "invalid_token" };
    return { ok: true, userId: body.sub };
  }
}
