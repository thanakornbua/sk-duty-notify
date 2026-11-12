// Shared by the admin pages: Carbon UI shell, session-aware API calls, small Carbon component builders.
// Signed-in state is an HttpOnly session cookie set by /admin/api/login; this script never sees it.
import { applyStatic, lang, setLang, t } from "/i18n.js";
export { hhmm } from "/i18n.js";

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

const back = () => encodeURIComponent(location.pathname + location.search);

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get("content-type") ?? "";
  const data = type.includes("json") ? await res.json() : await res.blob();
  if (res.status === 401 && path !== "/admin/api/login") { location.href = `/login?next=${back()}`; return new Promise(() => {}); }
  if (res.status === 403 && data?.error === "must_change_password") { location.href = "/account?first=1"; return new Promise(() => {}); }
  return { ok: res.ok, status: res.status, data };
}

const NAV = [["/dashboard", "nav.dashboard"], ["/sheet", "nav.sheet"], ["/admin", "nav.members"], ["/locations", "nav.locations"],
  ["/settings", "nav.settings"], ["/accounts", "nav.accounts"]];

/** ไทย / English switch (per browser). */
export const langSwitch = (kind = "ghost") => button(t("lang.other"), { kind, size: "sm", onclick: () => setLang(lang() === "th" ? "en" : "th") });

/** Require a signed-in admin, then render the Carbon UI shell header. Returns the user. */
export async function shell(active) {
  applyStatic();
  const { data } = await api("GET", "/admin/api/me");
  const user = data.user;
  if (user.mustChange && location.pathname !== "/account") { location.href = "/account?first=1"; return new Promise(() => {}); }
  const link = ([href, key]) => el("li", {}, el("a", { class: "cds--header__menu-item", href, "aria-current": href === active ? "page" : null },
    el("span", { class: "cds--text-truncate--end" }, t(key))));
  const header = el("header", { class: "cds--header", "aria-label": "SK Duty" },
    el("a", { class: "cds--header__name", href: "/dashboard" },
      el("img", { class: "brand-mark", src: "/brand/emblem-96.png", alt: "", width: 28, height: 28 }),
      el("span", { class: "cds--header__name--prefix" }, "SK"), "\u00a0Duty"),
    el("nav", { class: "cds--header__nav", "aria-label": "Main" }, el("ul", { class: "cds--header__menu-bar" }, NAV.map(link))),
    el("div", { class: "cds--header__global" },
      langSwitch(),
      el("a", { class: "cds--link who body", href: "/account" }, user.displayName),
      button(t("act.signOut"), { kind: "ghost", size: "sm", onclick: async () => { await api("POST", "/admin/api/logout"); location.href = "/login"; } })));
  const mobile = el("nav", { class: "mobile-nav", "aria-label": "Main" },
    ...NAV.map(([href, key]) => el("a", { href, "aria-current": href === active ? "page" : null }, t(key))),
    el("a", { href: "/account", "aria-current": active === "/account" ? "page" : null }, t("nav.account")));
  document.body.prepend(header, mobile);
  document.body.append(footer());
  return user;
}

/** Page footer: app name and the credits page. Used on every page. */
export const footer = () => el("footer", { class: "app-footer helper" },
  el("span", {}, "SK Duty"), el("span", { "aria-hidden": "true" }, "·"),
  el("a", { class: "cds--link cds--link--sm", href: "/credits" }, t("credits.link")));

export function button(label, { kind = "primary", size, onclick, type = "button", disabled, full, id } = {}) {
  const cls = ["cds--btn", `cds--btn--${kind}`, size && `cds--btn--${size}`, full && "cds--btn--full"].filter(Boolean).join(" ");
  return el("button", { class: cls, type, onclick, disabled, id }, label);
}

/** Carbon text input. Returns the wrapper; `.input` is the <input>, `.invalid(msg)` shows/clears an error. */
export function textInput({ id, label, type = "text", helper, value, ...attrs }) {
  const input = el("input", { id, type, class: "cds--text-input", value, ...attrs });
  const req = el("div", { class: "cds--form-requirement", id: `${id}-error` });
  const help = helper ? el("div", { class: "cds--form__helper-text" }, helper) : null;
  const field = el("div", { class: "cds--text-input__field-wrapper" }, input);
  const wrap = el("div", { class: "cds--form-item cds--text-input-wrapper" },
    el("label", { for: id, class: "cds--label" }, label),
    el("div", { class: "cds--text-input__field-outer-wrapper" }, field, req), help);
  wrap.input = input;
  wrap.invalid = (msg) => {
    input.classList.toggle("cds--text-input--invalid", !!msg);
    field.toggleAttribute("data-invalid", !!msg);
    input.setAttribute("aria-invalid", msg ? "true" : "false");
    req.textContent = msg ?? "";
    req.style.display = msg ? "block" : "none";
    if (help) help.hidden = !!msg;
  };
  return wrap;
}

export function select({ id, label, options, value }) {
  const s = el("select", { id, class: "cds--select-input" }, options.map(([v, t]) => el("option", { class: "cds--select-option", value: v, selected: v === value }, t)));
  const wrap = el("div", { class: "cds--form-item" }, el("div", { class: "cds--select" },
    el("label", { for: id, class: "cds--label" }, label), el("div", { class: "cds--select-input__wrapper" }, s)));
  wrap.input = s;
  return wrap;
}

/** kind: error | warning | success | info */
export function notification(kind, title, subtitle = "") {
  return el("div", { class: `cds--inline-notification cds--inline-notification--${kind} cds--inline-notification--low-contrast`, role: kind === "error" ? "alert" : "status" },
    el("div", { class: "cds--inline-notification__details" },
      el("div", { class: "cds--inline-notification__text-wrapper" },
        el("div", { class: "cds--inline-notification__title" }, title),
        subtitle ? el("div", { class: "cds--inline-notification__subtitle" }, subtitle) : null)));
}

/** "outside_geofence" -> "outside geofence" */
export const human = (code) => String(code).replace(/_/g, " ");

/** color: green | red | magenta | purple | blue | cyan | teal | gray | cool-gray | warm-gray | high-contrast | outline */
export const tag = (text, color = "gray") => el("span", { class: `cds--tag cds--tag--${color} cds--tag--sm` }, el("span", { class: "cds--tag__label" }, text));

/** Carbon data table. rows: arrays of cell content. */
export function dataTable({ title, description, columns, rows, empty = t("common.none"), toolbar }) {
  const body = rows.length
    ? rows.map((r) => el("tr", {}, r.map((c) => el("td", {}, c))))
    : [el("tr", {}, el("td", { colspan: columns.length, class: "secondary" }, empty))];
  return el("div", { class: "cds--data-table-container" },
    title ? el("div", { class: "cds--data-table-header" },
      el("h4", { class: "cds--data-table-header__title" }, title),
      description ? el("p", { class: "cds--data-table-header__description" }, description) : null) : null,
    toolbar ? el("section", { class: "cds--table-toolbar" }, el("div", { class: "cds--toolbar-content" }, toolbar)) : null,
    el("div", { class: "cds--data-table-content table-scroll" },
      el("table", { class: "cds--data-table cds--data-table--sm" },
        el("thead", {}, el("tr", {}, columns.map((c) => el("th", {}, el("div", { class: "cds--table-header-label" }, c))))),
        el("tbody", {}, body))));
}

/** Carbon modal. Resolves true on the primary button, false on cancel / Escape. */
export function modal({ title, label, body, primary = t("act.done"), secondary = t("act.cancel"), danger = false, validate }) {
  return new Promise((resolve) => {
    const err = el("div");
    const ok = button(primary, { kind: danger ? "danger" : "primary" });
    const cancel = secondary ? button(secondary, { kind: "secondary" }) : null;
    const box = el("div", { class: "cds--modal is-visible", role: "presentation" },
      el("div", { class: "cds--modal-container cds--modal-container--sm", role: "dialog", "aria-modal": "true", "aria-label": title },
        el("div", { class: "cds--modal-header" },
          label ? el("h2", { class: "cds--modal-header__label" }, label) : null,
          el("h3", { class: "cds--modal-header__heading" }, title)),
        el("div", { class: "cds--modal-content" }, body, err),
        el("div", { class: "cds--modal-footer cds--btn-set" }, cancel, ok)));
    const close = (v) => { box.remove(); document.removeEventListener("keydown", esc); resolve(v); };
    const esc = (e) => { if (e.key === "Escape") close(false); };
    ok.addEventListener("click", () => {
      const problem = validate?.();
      if (problem) { err.replaceChildren(notification("error", problem)); return; }
      close(true);
    });
    cancel?.addEventListener("click", () => close(false));
    document.addEventListener("keydown", esc);
    document.body.append(box);
    (box.querySelector("textarea, input") ?? ok).focus();
  });
}

export const bangkokToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
