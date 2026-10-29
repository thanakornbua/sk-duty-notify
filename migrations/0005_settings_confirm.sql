-- Scheduling settings edited on the management screen (defaults live in src/config.ts).
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL, -- JSON
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);

-- New message kind CONFIRM (sent after a successful check-in). SQLite cannot alter a CHECK, so rebuild outbox.
CREATE TABLE outbox_new (
  id              INTEGER PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('REMINDER', 'PROMPT', 'MISSED', 'CONFIRM')),
  dedupe_key      TEXT NOT NULL UNIQUE,
  member_id       INTEGER NOT NULL REFERENCES members (id),
  duty_date       TEXT NOT NULL,
  duty_id         INTEGER REFERENCES duties (id),
  status          TEXT NOT NULL CHECK (status IN ('QUEUED', 'LEASED', 'API_ACCEPTED', 'RETRY_WAIT', 'FAILED', 'SUPPRESSED', 'CANCELLED')),
  due_at          INTEGER NOT NULL,
  deadline_at     INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  lease_owner     TEXT,
  lease_until     INTEGER,
  target_user_id  TEXT,
  payload         TEXT,
  retry_key       TEXT,
  accepted_at     INTEGER,
  line_request_id TEXT,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
INSERT INTO outbox_new SELECT * FROM outbox;
DROP TABLE outbox;
ALTER TABLE outbox_new RENAME TO outbox;
CREATE INDEX outbox_due ON outbox (status, next_attempt_at);
CREATE INDEX outbox_date ON outbox (duty_date);
CREATE INDEX outbox_duty ON outbox (duty_id);
