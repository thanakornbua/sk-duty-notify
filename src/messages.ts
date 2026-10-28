import { config, type ActionKind } from "./config";
import type { LineMessage } from "./line";

export interface MessageInput {
  kind: ActionKind;
  phase: "INITIAL" | "REMINDER";
  dutyDate: string;
  actionId: number;
  revision: number;
  /** Only used for the ACK roster text. */
  roster: { position: string; label: string }[];
}

/** The exact LINE messages we push. The scheduler and the admin preview page both use this. */
export function buildMessages(i: MessageInput): LineMessage[] {
  const m = config.messages;
  const button = (text: string): LineMessage => ({
    type: "template",
    altText: text,
    template: {
      type: "buttons",
      text,
      // Postback carries only the action id + revision; everything else is looked up server-side.
      actions: [{ type: "postback", label: m.buttons[i.kind], data: `a=${i.actionId}&r=${i.revision}` }],
    },
  });

  if (i.phase === "REMINDER") {
    const what = i.kind === "ACK" ? "acknowledgement" : `${i.kind} check-in`;
    return [button(m.reminder(what))];
  }
  if (i.kind === "ACK") {
    // Roster order is the config order (P1, P2, ... P10), not alphabetical (which puts P10 before P2).
    const order = (p: string) => config.positions.indexOf(p as (typeof config.positions)[number]);
    const lines = [...i.roster].sort((a, b) => order(a.position) - order(b.position)).map((r) => `${r.position}: ${r.label}`).join("\n");
    return [{ type: "text", text: m.ack(i.dutyDate, lines) }, button("Acknowledge the roster")];
  }
  return [button(i.kind === "AM" ? m.checkInAm(i.dutyDate) : m.checkInPm(i.dutyDate))];
}
