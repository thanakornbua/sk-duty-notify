import type { Clock } from "./clock";

/**
 * LINE account <-> member linking. The member proves who they are by signing in with the Google account whose email
 * is on the roster (src/google.ts); the LINE user id comes from a LINE-verified ID token captured before the Google step.
 */

export type LinkOutcome =
  | { ok: true; staffCode: string; label: string }
  | { ok: false; reason: "not_on_roster" | "line_account_linked_elsewhere" };

/**
 * Bind the LINE user to the active member with this email. Re-linking a member to a new LINE account replaces the old one.
 * A LINE account already linked to ANOTHER member is refused.
 */
export async function linkMemberByEmail(db: D1Database, clock: Clock, userId: string, email: string): Promise<LinkOutcome> {
  const m = await db.prepare("SELECT id, staff_code, label FROM members WHERE email = ? AND active = 1")
    .bind(email.toLowerCase()).first<{ id: number; staff_code: string; label: string }>();
  if (!m) return { ok: false, reason: "not_on_roster" };
  const now = clock.now();
  try {
    await db.batch([
      db.prepare("UPDATE members SET line_user_id = ?, linked_at = ? WHERE id = ?").bind(userId, now, m.id),
      db.prepare("INSERT INTO audit_log (at, actor, event, detail) VALUES (?, 'member', 'line_linked', ?)")
        .bind(now, JSON.stringify({ member_id: m.id, via: "google" })),
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE") && String(e).includes("line_user_id")) return { ok: false, reason: "line_account_linked_elsewhere" };
    throw e;
  }
  return { ok: true, staffCode: m.staff_code, label: m.label };
}
