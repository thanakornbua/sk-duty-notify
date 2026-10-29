// Shared by the LIFF pages. The page never decides who the user is: it sends LINE's ID token and the server verifies it.
import { langSwitch, notification } from "/admin-common.js";
import { applyStatic } from "/i18n.js";

/** Language + static texts + the ไทย/English switch in the corner. */
export function setupPage() {
  applyStatic();
  const corner = document.createElement("div");
  corner.className = "lang-corner";
  corner.append(langSwitch());
  document.body.append(corner);
}

export const $ = (id) => document.getElementById(id);

/** Replace the contents of #id with a Carbon notification (kind: error | warning | success | info), or clear it. */
export function show(id, kind, title, subtitle = "") {
  $(id).replaceChildren(...(kind ? [notification(kind, title, subtitle)] : []));
}

export async function initLiff() {
  const cfg = await fetch("/api/liff-config").then((r) => r.json());
  if (!cfg.liffId) throw new Error("LIFF is not configured on the server");
  await liff.init({ liffId: cfg.liffId });
  if (!liff.isLoggedIn()) {
    liff.login({ redirectUri: location.href });
    return false;
  }
  return true;
}

/** POST with the current ID token. An expired token gets one re-login. */
export async function api(path, body = {}) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, idToken: liff.getIDToken() }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.error === "invalid_token" && !sessionStorage.getItem("relogged")) {
    sessionStorage.setItem("relogged", "1");
    liff.logout();
    liff.login({ redirectUri: location.href });
    return new Promise(() => {}); // navigating away
  }
  sessionStorage.removeItem("relogged");
  return { status: res.status, data };
}

export { hhmm } from "/i18n.js";
