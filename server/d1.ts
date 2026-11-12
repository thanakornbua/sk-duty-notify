/**
 * The subset of Cloudflare's D1 API that src/ uses, on top of Node's built-in SQLite (node:sqlite).
 * prepare().bind().first()/all()/run() and db.batch() (atomic). Same SQL, same result shapes, so src/ runs unchanged.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

type Value = null | number | bigint | string | Uint8Array;

function toSqlite(v: unknown): Value {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0; // D1 stores booleans as 0/1
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "string" || v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  throw new TypeError(`D1_TYPE_ERROR: unsupported value type ${typeof v}`);
}

const READS = /^\s*(select|with|pragma|explain|values)\b/i;

interface Result { results: Record<string, unknown>[]; success: true; meta: { changes: number; last_row_id: number; duration: number; rows_read: number; rows_written: number } }

export class SqliteD1 {
  readonly sqlite: DatabaseSync;
  private cache = new Map<string, StatementSync>();

  constructor(path: string) {
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  }

  stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) { s = this.sqlite.prepare(sql); this.cache.set(sql, s); }
    return s;
  }

  /** Execute one statement synchronously and shape the result like D1. */
  execute(sql: string, params: Value[]): Result {
    const s = this.stmt(sql);
    const t0 = performance.now();
    let results: Record<string, unknown>[] = [];
    let changes = 0, lastRowId = 0;
    if (s.columns().length > 0) {
      results = s.all(...params) as Record<string, unknown>[];
      // RETURNING: one row per changed row. Plain reads change nothing.
      if (!READS.test(sql)) changes = results.length;
    } else {
      const r = s.run(...params);
      changes = Number(r.changes);
      lastRowId = Number(r.lastInsertRowid);
    }
    return {
      results, success: true,
      meta: { changes, last_row_id: lastRowId, duration: performance.now() - t0, rows_read: results.length, rows_written: changes },
    };
  }

  prepare(sql: string) {
    return new Statement(this, sql, []);
  }

  /** All statements in one transaction, like D1: all succeed or none. */
  async batch(statements: Statement[]): Promise<Result[]> {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const out = statements.map((s) => this.execute(s.sql, s.params));
      this.sqlite.exec("COMMIT");
      return out;
    } catch (e) {
      this.sqlite.exec("ROLLBACK");
      throw e;
    }
  }

  async exec(sql: string) {
    this.sqlite.exec(sql);
    return { count: 0, duration: 0 };
  }

  /** Apply migrations/*.sql not yet recorded, in name order (same bookkeeping table name as wrangler). */
  migrate(dir: string): string[] {
    this.sqlite.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    const done = new Set((this.sqlite.prepare("SELECT name FROM d1_migrations").all() as { name: string }[]).map((r) => r.name));
    const applied: string[] = [];
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      if (done.has(name)) continue;
      this.sqlite.exec("BEGIN IMMEDIATE");
      try {
        this.sqlite.exec(readFileSync(join(dir, name), "utf8"));
        this.sqlite.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
        this.sqlite.exec("COMMIT");
      } catch (e) {
        this.sqlite.exec("ROLLBACK");
        throw new Error(`migration ${name} failed: ${(e as Error).message}`);
      }
      applied.push(name);
    }
    return applied;
  }

  /** Consistent online copy of the database (safe while the app runs). */
  backup(file: string) {
    this.sqlite.prepare("VACUUM INTO ?").run(file);
  }

  close() {
    this.sqlite.close();
  }
}

export class Statement {
  constructor(private db: SqliteD1, readonly sql: string, readonly params: Value[]) {}

  bind(...values: unknown[]) {
    return new Statement(this.db, this.sql, values.map(toSqlite));
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.db.execute(this.sql, this.params).results[0];
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }

  async all<T = Record<string, unknown>>() {
    return this.db.execute(this.sql, this.params) as unknown as { results: T[]; success: true; meta: Result["meta"] };
  }

  async run() {
    return this.db.execute(this.sql, this.params);
  }

  async raw<T = unknown[]>() {
    return this.db.execute(this.sql, this.params).results.map((r) => Object.values(r)) as T[];
  }
}
