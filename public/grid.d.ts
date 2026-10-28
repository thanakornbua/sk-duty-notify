export type NormalizedImport = { days: { date: string; assignments: { position: string; staffId: string }[] }[] };
export function serialToDate(serial: number, date1904?: boolean): string | null;
export function parseDateCell(v: unknown, date1904?: boolean): string | null;
export function parseGrid(
  grid: unknown[][],
  opts?: { date1904?: boolean; merges?: { s: { r: number; c: number }; e: { r: number; c: number } }[] },
): { ok: true; data: NormalizedImport } | { ok: false; errors: string[] };
