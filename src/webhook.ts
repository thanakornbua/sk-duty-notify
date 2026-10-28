import type { Clock } from "./clock";
import { CODE_ALPHABET, CODE_LENGTH, config } from "./config";
import type { Env } from "./index";
import type { LineClient, LineMessage } from "./line";

const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);
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

export function newBindingCode(): string {
  // Rejection sampling: 31 symbols * 8 = 248, so bytes >= 248 are discarded to avoid modulo bias.
  let out = "";
  while (out.length < CODE_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < 248 && out.length < CODE_LENGTH) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
    }
  }
  return out;
}

interface LineEvent {
  type?: string;
  webhookEventId?: string;
  replyToken?: string;
  source?: { type?: string; userId?: string };
  message?: { type?: string; text?: string };
  postback?: { data?: string };
}

/**
 * Order of work for every event: decide -> commit (state change + dedupe row in ONE batch) -> reply.
 * If the DB fails we return 5xx so LINE redelivers; because the dedupe row commits with the action,
 * a failed attempt leaves no trace and the redelivery is processed normally.
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
    try {
      const reply = await processEvent(env.DB, clock, ev);
      if (reply && ev.replyToken && line) {
        try { await line.reply(ev.replyToken, [{ type: "text", text: reply } as LineMessage]); } catch { /* state is committed; reply is best effort */ }
      }
    } catch (e) {
      console.error("webhook event failed", ev.webhookEventId, e);
      return new Response("temporary failure", { status: 500 });
    }
  }
  return new Response("ok");
}

const R = config.messages.replies;
export const WHAT: Record<string, string> = { ACK: "Acknowledgement", AM: "AM check-in", PM: "PM check-in" };

/** Returns reply text (or undefined for none). Throws on DB failure. */
async function processEvent(db: D1Database, clock: Clock, ev: LineEvent): Promise<string | undefined> {
  const eventId = ev.webhookEventId;
  if (typeof eventId !== "string" || !eventId) return undefined; // cannot dedupe safely; LINE always sets it

  if (await db.prepare("SELECT 1 FROM webhook_events WHERE webhook_event_id = ?").bind(eventId).first()) return undefined;

  const now = clock.now();
  const userId = ev.source?.type === "user" ? ev.source.userId : undefined; // private chats only
  const record = (outcome: string) =>
    db.prepare("INSERT INTO webhook_events (webhook_event_id, received_at, event_type, outcome) VALUES (?, ?, ?, ?)")
      .bind(eventId, now, ev.type ?? "unknown", outcome);

  try {
    if (ev.type === "postback" && userId) return await onPostback(db, now, ev, userId, eventId, record);
    if (ev.type === "message" && ev.message?.type === "text" && userId) return await onText(db, now, ev, userId, eventId, record);
    await record("ignored").run();
    return undefined;
  } catch (e) {
    // Lost a race with a concurrent delivery of the same event: it was handled, so do nothing more.
    if (await db.prepare("SELECT 1 FROM webhook_events WHERE webhook_event_id = ?").bind(eventId).first()) return undefined;
    throw e;
  }
}

/* --------------------------------------------------------------- postback */

interface ActionRow {
  id: number;
  assignment_id: number;
  action_kind: string;
  revision: number;
  state: string;
  outcome: string | null;
  opens_at: number;
  late_after_at: number;
  cutoff_at: number;
  is_active: number;
  withdrawn: number;
  bound_user: string | null;
}

const ACTION_SQL = `
  SELECT s.id, s.assignment_id, s.action_kind, s.revision, s.state, s.outcome, s.opens_at, s.late_after_at, s.cutoff_at,
         a.is_active, a.withdrawn, p.line_user_id AS bound_user
  FROM action_states s
  JOIN assignments a ON a.id = s.assignment_id
  JOIN people p ON p.staff_id = a.staff_id
  WHERE s.id = ?`;

async function onPostback(
  db: D1Database, now: number, ev: LineEvent, userId: string, eventId: string,
  record: (outcome: string) => D1PreparedStatement,
): Promise<string> {
  // Postback data is only "a=<action id>&r=<revision>". Everything else comes from our own tables.
  const m = /^a=(\d+)&r=(\d+)$/.exec(ev.postback?.data ?? "");
  const act = m ? await db.prepare(ACTION_SQL).bind(Number(m[1])).first<ActionRow>() : null;
  if (!act) { await record("unknown_button").run(); return R.unknownButton; }

  const what = WHAT[act.action_kind];
  const refuse = async (outcome: string, text: string, extra: D1PreparedStatement[] = []) => {
    await db.batch([...extra, record(outcome)]);
    return text;
  };

  // A forwarded button must not work for anyone but the person bound to that assignment.
  if (!act.bound_user || act.bound_user !== userId) return refuse("not_owner", R.notYours);
  if (Number(m![2]) !== act.revision) return refuse("stale_revision", R.stale);
  if (!act.is_active || act.withdrawn || act.state === "CANCELLED") return refuse("cancelled", R.closed(what));
  if (act.state === "COMPLETED") return refuse("already", R.already(what, act.outcome === "late"));
  if (act.state === "EXPIRED" || now >= act.cutoff_at) {
    const expire = db.prepare("UPDATE action_states SET state = 'EXPIRED', updated_at = ? WHERE id = ? AND state = 'PENDING'").bind(now, act.id);
    return refuse("closed", R.closed(what), [expire]);
  }
  if (now < act.opens_at) return refuse("not_open", R.notOpen(what));

  // Commit the action BEFORE replying. Conditional UPDATE: of two simultaneous taps exactly one changes the row.
  // The event row records the outcome using changes() from the UPDATE just before it, in the same transaction.
  const late = now > act.late_after_at; // exactly start+30 min is still on time
  const [upd] = await db.batch([
    db.prepare(
      `UPDATE action_states SET state = 'COMPLETED', outcome = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND state = 'PENDING' AND revision = ?`,
    ).bind(late ? "late" : "on_time", now, now, act.id, act.revision),
    db.prepare(
      `INSERT INTO webhook_events (webhook_event_id, received_at, event_type, outcome)
       VALUES (?, ?, 'postback', CASE WHEN changes() = 1 THEN 'completed' ELSE 'already' END)`,
    ).bind(eventId, now),
    db.prepare(
      `INSERT INTO audit_log (at, actor, event, detail)
       SELECT ?1, 'webhook', 'action_completed', json_object('action', id, 'kind', action_kind, 'outcome', outcome)
       FROM action_states WHERE id = ?2 AND completed_at = ?1`,
    ).bind(now, act.id),
  ]);
  if (upd.meta.changes === 1) return R.completed(what, late);
  const cur = await db.prepare(ACTION_SQL).bind(act.id).first<ActionRow>(); // lost the race: report what is true now
  return R.already(what, cur?.outcome === "late");
}

/* ------------------------------------------------------------------- text */

async function onText(
  db: D1Database, now: number, ev: LineEvent, userId: string, eventId: string,
  record: (outcome: string) => D1PreparedStatement,
): Promise<string> {
  const code = (ev.message?.text ?? "").replace(/\s+/g, "").toUpperCase();
  if (!CODE_RE.test(code)) { await record("help").run(); return R.help; }

  try {
    // One transaction: bind only if the code is unused, unrevoked and unexpired. The people UPDATE runs first and the
    // code UPDATE second, both on the same condition, so changes() on the event row reflects success.
    const [bind] = await db.batch([
      db.prepare(
        `UPDATE people SET line_user_id = ?1, bound_at = ?2
         WHERE active = 1 AND staff_id = (SELECT staff_id FROM binding_codes
                                          WHERE code = ?3 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?2)`,
      ).bind(userId, now, code),
      db.prepare(
        "UPDATE binding_codes SET used_at = ?1 WHERE code = ?2 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?1",
      ).bind(now, code),
      db.prepare(
        `INSERT INTO webhook_events (webhook_event_id, received_at, event_type, outcome)
         VALUES (?, ?, 'message', CASE WHEN changes() = 1 THEN 'bound' ELSE 'bind_failed' END)`,
      ).bind(eventId, now),
      db.prepare(
        `INSERT INTO audit_log (at, actor, event, detail)
         SELECT ?1, 'webhook', 'staff_bound', json_object('staff_id', staff_id) FROM binding_codes
         WHERE code = ?2 AND used_at = ?1`,
      ).bind(now, code),
    ]);
    if (bind.meta.changes !== 1) return R.bindFailed;
    const row = await db.prepare("SELECT staff_id FROM people WHERE line_user_id = ?").bind(userId).first<{ staff_id: string }>();
    return R.bound(row!.staff_id);
  } catch (e) {
    // The LINE user is already linked to a different staff ID (unique index). Nothing was committed.
    if (String(e).includes("UNIQUE") && String(e).includes("line_user_id")) {
      await record("already_bound").run();
      return R.alreadyBound;
    }
    throw e;
  }
}
