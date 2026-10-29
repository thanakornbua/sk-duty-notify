import type { Clock } from "./clock";
import { config } from "./config";
import { MIN } from "./time";
import { sha256Hex } from "./util";

/** 31 symbols: no I, L, O, 0, 1. */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 8;
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

export function newLinkCode(): string {
  // Rejection sampling: 31 * 8 = 248, so bytes >= 248 are discarded to avoid modulo bias.
  let out = "";
  while (out.length < CODE_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < 248 && out.length < CODE_LENGTH) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
    }
  }
  return out;
}

export const normalizeCode = (s: string) => s.replace(/[\s-]+/g, "").toUpperCase();

/** A new code revokes any unused older one for the same member. Only the hash is stored. */
export async function issueLinkCode(db: D1Database, clock: Clock, memberId: number, actor = "admin") {
  const now = clock.now();
  const code = newLinkCode();
  const expiresAt = now + config.linkCodeTtlMinutes * MIN;
  await db.batch([
    db.prepare("UPDATE link_codes SET revoked_at = ? WHERE member_id = ? AND used_at IS NULL AND revoked_at IS NULL").bind(now, memberId),
    db.prepare("INSERT INTO link_codes (member_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(memberId, await sha256Hex(code), now, expiresAt),
    db.prepare("INSERT INTO audit_log (at, actor, event, detail) VALUES (?, ?, 'link_code_issued', ?)")
      .bind(now, actor, JSON.stringify({ memberId })),
  ]);
  return { code, expiresAt };
}

export type LinkOutcome =
  | { ok: true; staffCode: string; label: string }
  /** Unknown, expired, used and revoked codes all look the same to the caller. */
  | { ok: false; reason: "bad_code" | "line_account_linked_elsewhere" };

/**
 * Bind the verified LINE userId to the member owning the code. Re-linking a member to a new LINE account
 * replaces the old one. A LINE account already linked to ANOTHER member is refused and the code is not consumed.
 */
export async function linkWithCode(db: D1Database, clock: Clock, userId: string, rawCode: string): Promise<LinkOutcome> {
  const code = normalizeCode(rawCode);
  if (!CODE_RE.test(code)) return { ok: false, reason: "bad_code" };
  const hash = await sha256Hex(code);
  const now = clock.now();

  const valid = "SELECT member_id FROM link_codes WHERE code_hash = ?3 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?2";
  try {
    // One transaction. The code is consumed only if the members UPDATE just before it changed a row (changes()).
    const [bind] = await db.batch([
      db.prepare(`UPDATE members SET line_user_id = ?1, linked_at = ?2 WHERE active = 1 AND id = (${valid})`).bind(userId, now, hash),
      db.prepare(`UPDATE link_codes SET used_at = ?1
                  WHERE code_hash = ?2 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?1 AND changes() = 1`)
        .bind(now, hash),
      db.prepare(`INSERT INTO audit_log (at, actor, event, detail)
                  SELECT ?1, 'member', 'line_linked', json_object('member_id', member_id) FROM link_codes WHERE code_hash = ?2 AND used_at = ?1`)
        .bind(now, hash),
    ]);
    if (bind.meta.changes !== 1) return { ok: false, reason: "bad_code" };
  } catch (e) {
    if (String(e).includes("UNIQUE") && String(e).includes("line_user_id")) return { ok: false, reason: "line_account_linked_elsewhere" };
    throw e;
  }
  const m = await db.prepare("SELECT staff_code, label FROM members WHERE line_user_id = ?").bind(userId)
    .first<{ staff_code: string; label: string }>();
  return { ok: true, staffCode: m!.staff_code, label: m!.label };
}
