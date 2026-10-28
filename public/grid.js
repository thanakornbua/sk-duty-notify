// Pure grid -> normalized JSON. Runs in the browser (admin page) and in tests. No DOM, no SheetJS.
//
// grid:   array of rows, each an array of raw cell values (number | string | Date | null).
//         Row 0 = dates (col 0 is the corner label). Col 0 = positions. Cells = staff IDs.
// opts:   { date1904?: boolean, merges?: [{s:{r,c}, e:{r,c}}] }
// result: { ok: true, data: { days: [{ date, assignments: [{ position, staffId }] }] } }
//       | { ok: false, errors: string[] }
// An entirely empty date column => explicit NO_DUTY day (days[].assignments = []).
// Dates absent from the file are simply not listed: the server treats them as UNKNOWN.

const BE_OFFSET = 543;

const pad = (n) => String(n).padStart(2, "0");

function ymd(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Buddhist-era years (2400+) are converted to Gregorian. Anything outside 2000..2200 is rejected. */
function fixYear(y) {
  if (y >= 2400 && y <= 2800) y -= BE_OFFSET;
  return y >= 2000 && y <= 2200 ? y : null;
}

/** Excel serial -> 'YYYY-MM-DD'. 1900 system has the fake 1900-02-29 (serial 60). */
export function serialToDate(serial, date1904 = false) {
  if (!Number.isFinite(serial) || serial < 1) return null;
  const whole = Math.floor(serial);
  let ms;
  if (date1904) {
    ms = Date.UTC(1904, 0, 1) + whole * 86400000;
  } else {
    if (whole === 60) return null; // nonexistent 1900-02-29
    ms = Date.UTC(1899, 11, 30) + whole * 86400000;
  }
  const dt = new Date(ms);
  const y = fixYear(dt.getUTCFullYear());
  return y === null ? null : ymd(y, dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** Header cell -> 'YYYY-MM-DD' or null. Accepts serials, Date objects, 'YYYY-MM-DD', 'DD/MM/YYYY' (day first). */
export function parseDateCell(v, date1904 = false) {
  if (typeof v === "number") return serialToDate(v, date1904);
  if (v instanceof Date) {
    const y = fixYear(v.getFullYear());
    return y === null ? null : ymd(y, v.getMonth() + 1, v.getDate());
  }
  if (typeof v === "string") {
    const s = v.trim();
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    if (m) { const y = fixYear(+m[1]); return y === null ? null : ymd(y, +m[2], +m[3]); }
    m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
    if (m) { const y = fixYear(+m[3]); return y === null ? null : ymd(y, +m[2], +m[1]); }
  }
  return null;
}

const isBlank = (v) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

export function parseGrid(grid, opts = {}) {
  const errors = [];
  if (!Array.isArray(grid) || grid.length < 2 || !Array.isArray(grid[0]) || grid[0].length < 2) {
    return { ok: false, errors: ["Sheet needs a header row of dates and at least one position row"] };
  }

  // Merged cells anywhere in the data area (below the header, right of the position column).
  for (const m of opts.merges ?? []) {
    if (m.e.r >= 1 && m.e.c >= 1) {
      errors.push(`Merged cells in data area (row ${m.s.r + 1}, col ${m.s.c + 1} to row ${m.e.r + 1}, col ${m.e.c + 1})`);
    }
  }

  const header = grid[0];
  const positions = [];
  for (let r = 1; r < grid.length; r++) {
    const p = grid[r]?.[0];
    if (isBlank(p)) {
      // A blank position label is only OK on a fully blank row.
      if ((grid[r] ?? []).some((c, i) => i > 0 && !isBlank(c))) errors.push(`Row ${r + 1}: staff IDs but no position label`);
      positions.push(null);
    } else {
      positions.push(String(p).trim());
    }
  }
  const seenPos = new Set();
  for (const p of positions) {
    if (p === null) continue;
    if (seenPos.has(p)) errors.push(`Duplicate position label "${p}"`);
    seenPos.add(p);
  }

  const days = [];
  const seenDates = new Map();
  for (let c = 1; c < header.length; c++) {
    if (isBlank(header[c])) {
      if (grid.some((row, r) => r > 0 && !isBlank(row?.[c]))) errors.push(`Column ${c + 1}: data but no date in header`);
      continue;
    }
    const date = parseDateCell(header[c], !!opts.date1904);
    if (!date) { errors.push(`Column ${c + 1}: unreadable date ${JSON.stringify(header[c])}`); continue; }
    if (seenDates.has(date)) { errors.push(`Duplicate date ${date} (columns ${seenDates.get(date)} and ${c + 1})`); continue; }
    seenDates.set(date, c + 1);

    const assignments = [];
    for (let r = 1; r < grid.length; r++) {
      const cell = grid[r]?.[c];
      if (isBlank(cell)) continue;
      if (positions[r - 1] === null) continue; // already reported above
      assignments.push({ position: positions[r - 1], staffId: String(cell).trim() });
    }
    days.push({ date, assignments });
  }
  if (days.length === 0 && errors.length === 0) errors.push("No dates found");

  return errors.length ? { ok: false, errors } : { ok: true, data: { days } };
}
