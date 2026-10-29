// Shared by the admin pages. Auth is a STUB: one shared bearer token typed into the page, kept in sessionStorage.
export function token() {
  let t = null;
  try { t = sessionStorage.getItem("adminToken"); } catch {}
  if (!t) {
    t = prompt("Admin token (STUB auth)") ?? "";
    try { sessionStorage.setItem("adminToken", t); } catch {}
  }
  return t;
}

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${token()}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { try { sessionStorage.removeItem("adminToken"); } catch {} }
  const type = res.headers.get("content-type") ?? "";
  const data = type.includes("json") ? await res.json() : await res.blob();
  return { ok: res.ok, status: res.status, data };
}

/** Build DOM without innerHTML. */
export function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : String(k));
  return e;
}

const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" });
export const hhmm = (t) => (t == null ? "" : fmt.format(new Date(t)));
export const bangkokToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
