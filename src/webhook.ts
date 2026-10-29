import type { Clock } from "./clock";
import { config } from "./config";
import type { Env } from "./index";
import type { LineClient, LineMessage } from "./line";
import { liffUrl } from "./messages";

const enc = new TextEncoder();

/** HMAC-SHA256 over the RAW body, compared by Web Crypto's verify (constant time). */
export async function verifySignature(secret: string, raw: ArrayBuffer, signatureB64: string): Promise<boolean> {
  let sig: Uint8Array;
  try {
    sig = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, sig, raw);
}

interface LineEvent {
  type?: string;
  webhookEventId?: string;
  replyToken?: string;
  source?: { type?: string; userId?: string };
  message?: { type?: string };
}

/**
 * The webhook only greets and points people at the LIFF pages; linking and check-in happen there.
 * Dedupe row commits before the reply. A DB failure returns 5xx so LINE redelivers.
 */
export async function handleWebhook(req: Request, env: Env, clock: Clock, line?: LineClient): Promise<Response> {
  if (!env.LINE_CHANNEL_SECRET) return new Response("webhook not configured", { status: 500 });

  const raw = await req.arrayBuffer();
  const signature = req.headers.get("x-line-signature");
  if (!signature || !(await verifySignature(env.LINE_CHANNEL_SECRET, raw, signature))) {
    return new Response("bad signature", { status: 401 });
  }

  let body: { events?: LineEvent[] };
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return new Response("bad json", { status: 400 });
  }
  if (!Array.isArray(body.events)) return new Response("bad payload", { status: 400 });

  for (const ev of body.events) {
    const id = ev.webhookEventId;
    if (typeof id !== "string" || !id) continue;
    const privateChat = ev.source?.type === "user";
    const reply =
      !privateChat ? undefined
      : ev.type === "follow" ? config.messages[config.messageLanguage].followReply(liffUrl(env.LIFF_ID ?? "LIFF_ID_NOT_SET", "link"))
      : ev.type === "message" ? config.messages[config.messageLanguage].help(liffUrl(env.LIFF_ID ?? "LIFF_ID_NOT_SET"))
      : undefined;
    try {
      const r = await env.DB.prepare(
        "INSERT OR IGNORE INTO webhook_events (webhook_event_id, received_at, event_type, outcome) VALUES (?, ?, ?, ?)",
      ).bind(id, clock.now(), ev.type ?? "unknown", reply ? "replied" : "ignored").run();
      if (r.meta.changes !== 1) continue; // redelivery: already handled
    } catch (e) {
      console.error("webhook event failed", id, e);
      return new Response("temporary failure", { status: 500 });
    }
    if (reply && ev.replyToken && line) {
      // Best effort, but never silent: a failed reply is logged and marked on the event row.
      const ok = await line.reply(ev.replyToken, [{ type: "text", text: reply } as LineMessage]).then((r) => r.ok, () => false);
      if (!ok) {
        console.error("webhook reply failed", id);
        await env.DB.prepare("UPDATE webhook_events SET outcome = 'reply_failed' WHERE webhook_event_id = ?").bind(id).run().catch(() => {});
      }
    }
  }
  return new Response("ok");
}
