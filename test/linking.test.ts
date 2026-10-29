import { beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock";
import { FakeLineClient } from "../src/line-fake";
import { admin, at, call, D, db, MIN, reset, seedMembers, token } from "./helpers";

let line: FakeLineClient, clock: FixedClock;
const issue = async (memberId: number) => (await (await admin(line, clock, "POST", `/admin/api/members/${memberId}/link-code`)).json()) as { code: string };
const link = (n: number, code: string) => call(line, clock, "POST", "/api/link", { idToken: token(n), code });

describe("account linking (LIFF + one-time code)", () => {
  beforeEach(async () => {
    await reset();
    await seedMembers(3, { unlinked: [1, 2, 3] });
    line = new FakeLineClient();
    clock = new FixedClock(at(D, "09:00"));
  });

  it("links the verified LINE user to the member; code is single use and stored hashed", async () => {
    const { code } = await issue(1);
    expect(await db.prepare("SELECT 1 FROM link_codes WHERE code_hash = ?").bind(code).first()).toBeNull();
    const res = await link(1, code.toLowerCase().replace(/(....)/, "$1-")); // tolerant of case and dashes
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, staffCode: "S001" });
    expect((await db.prepare("SELECT line_user_id FROM members WHERE id = 1").first())!.line_user_id).toBe("U001");
    expect((await link(2, code)).status).toBe(422);
  });

  it("invalid ID token is refused before the code is looked at", async () => {
    const { code } = await issue(1);
    const res = await call(line, clock, "POST", "/api/link", { idToken: "forged", code });
    expect(res.status).toBe(401);
    expect((await link(1, code)).status).toBe(200); // code still usable
  });

  it("expired and revoked codes fail identically", async () => {
    const first = await issue(1);
    const second = await issue(1); // revokes first
    expect(await (await link(1, first.code)).json()).toEqual({ error: "bad_code" });
    clock.advance(16 * MIN);
    expect(await (await link(1, second.code)).json()).toEqual({ error: "bad_code" });
  });

  it("a LINE account linked to another member is refused and the code is not consumed", async () => {
    await link(1, (await issue(1)).code);
    const { code } = await issue(2);
    const res = await link(1, code); // U001 tries member 2's code
    expect(await res.json()).toEqual({ error: "line_account_linked_elsewhere" });
    expect((await link(2, code)).status).toBe(200);
  });

  it("an inactive member's code does not link and is not consumed", async () => {
    const { code } = await issue(3);
    await db.prepare("UPDATE members SET active = 0 WHERE id = 3").run();
    expect((await link(3, code)).status).toBe(422);
    expect((await db.prepare("SELECT used_at FROM link_codes").first())!.used_at).toBeNull();
  });

  it("relinking a member to a new LINE account replaces the old one", async () => {
    await link(1, (await issue(1)).code);
    await link(2, (await issue(1)).code); // member 1 now on U002
    expect((await db.prepare("SELECT line_user_id FROM members WHERE id = 1").first())!.line_user_id).toBe("U002");
  });
});
