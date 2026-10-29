// Spreadsheet rows -> normalized roster JSON. Runs in the browser (and in tests). The server revalidates everything.
// Expected header row (any order, case-insensitive): date, staff_code, location_code, shift, start, end.
// A row with a date and nothing else marks an explicit "no duty" date.

const HEADERS = { date: "date", staff_code: "staffCode", location_code: "locationCode", shift: "shift", start: "start", end: "end" };
const pad = (n) => String(n).padStart(2, "0");

/** Excel serial (1900 or 1904 system), YYYY-MM-DD, or day-first D/M/YYYY. Buddhist-era years (2400-2800) are converted. */
export function normalizeDate(v, date1904 = false) {
  if (typeof v === "number" && Number.isFinite(v)) {
    const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
    const d = new Date(epoch + Math.round(v) * 86400000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  const s = String(v ?? "").trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  let y, mo, d;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(s))) [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else return s; // left as-is: the server reports it as invalid
  if (y >= 2400 && y <= 2800) y -= 543;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

/** Excel time fraction or H:MM -> HH:MM. Empty stays empty. */
export function normalizeTime(v) {
  if (v === undefined || v === null || v === "") return "";
  if (typeof v === "number" && v >= 0 && v < 1) {
    const mins = Math.round(v * 1440);
    return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
  }
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(String(v).trim());
  return m ? `${pad(Number(m[1]))}:${m[2]}` : String(v).trim();
}

/** aoa = array of arrays (first row = headers), as from XLSX.utils.sheet_to_json(ws, { header: 1, raw: true }). */
export function normalizeRows(aoa, { date1904 = false } = {}) {
  const errors = [];
  const [head, ...body] = aoa;
  const cols = {};
  (head ?? []).forEach((h, i) => {
    const key = HEADERS[String(h ?? "").trim().toLowerCase().replace(/\s+/g, "_")];
    if (key) cols[key] = i;
  });
  for (const req of ["date", "staffCode", "locationCode", "shift"]) {
    if (cols[req] === undefined) errors.push(`missing column: ${Object.keys(HEADERS).find((k) => HEADERS[k] === req)}`);
  }
  if (errors.length) return { rows: [], errors };

  const rows = [];
  body.forEach((r, i) => {
    if (!r || r.every((c) => c === undefined || c === null || String(c).trim() === "")) return; // blank line
    const cell = (k) => (cols[k] === undefined ? "" : r[cols[k]]);
    const text = (k) => String(cell(k) ?? "").trim();
    rows.push({
      line: i + 2,
      date: normalizeDate(cell("date"), date1904),
      staffCode: text("staffCode"),
      locationCode: text("locationCode"),
      shift: text("shift").toUpperCase(),
      start: normalizeTime(cell("start")),
      end: normalizeTime(cell("end")),
    });
  });
  if (!rows.length) errors.push("no data rows");
  return { rows, errors };
}
