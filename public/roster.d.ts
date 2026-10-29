export function normalizeDate(v: unknown, date1904?: boolean): string;
export function normalizeTime(v: unknown): string;
export function normalizeRows(aoa: unknown[][], opts?: { date1904?: boolean }): {
  rows: { line: number; date: string; staffCode: string; locationCode: string; shift: string; start: string; end: string }[];
  errors: string[];
};
