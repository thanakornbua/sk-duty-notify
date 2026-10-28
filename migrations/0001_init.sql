-- Conventions
--   *_at / *_until columns: UTC instants, epoch milliseconds (INTEGER).
--   duty_date: Asia/Bangkok calendar date, 'YYYY-MM-DD' (TEXT). Never derived from UTC.
--   "api_accepted_at" = LINE API accepted the push. It is NOT delivery and NOT user action.
--   "completed_at"    = the user pressed the button. Kept in a different table on purpose.

CREATE TABLE people (
  staff_id      TEXT PRIMARY KEY,
  label         TEXT NOT NULL,                 -- synthetic display label, never used to bind
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  line_user_id  TEXT,                          -- set only by the webhook binding flow
  bound_at      INTEGER
);
-- One active LINE user per staff ID (column is single-valued) and one staff ID per LINE user.
CREATE UNIQUE INDEX uq_people_line_user ON people (line_user_id) WHERE line_user_id IS NOT NULL;

CREATE TABLE roster_revisions (
  id            INTEGER PRIMARY KEY,
  content_hash  TEXT NOT NULL UNIQUE,          -- same hash => no-op re-import
  status        TEXT NOT NULL CHECK (status IN ('STAGED', 'ACTIVE', 'SUPERSEDED')),
  created_at    INTEGER NOT NULL,
  published_at  INTEGER
);
-- At most one ACTIVE revision.
CREATE UNIQUE INDEX uq_one_active_revision ON roster_revisions (status) WHERE status = 'ACTIVE';

CREATE TABLE roster_days (
  id          INTEGER PRIMARY KEY,
  revision_id INTEGER NOT NULL REFERENCES roster_revisions (id),
  duty_date   TEXT NOT NULL CHECK (duty_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  state       TEXT NOT NULL CHECK (state IN ('DUTY', 'NO_DUTY', 'UNKNOWN')),
  UNIQUE (revision_id, duty_date)
);

CREATE TABLE assignments (
  id          INTEGER PRIMARY KEY,
  revision_id INTEGER NOT NULL REFERENCES roster_revisions (id),
  duty_date   TEXT NOT NULL CHECK (duty_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  position    TEXT NOT NULL,
  staff_id    TEXT NOT NULL REFERENCES people (staff_id),
  -- 1 only while the owning revision is ACTIVE. Flipped atomically at publish.
  is_active   INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  withdrawn   INTEGER NOT NULL DEFAULT 0 CHECK (withdrawn IN (0, 1)),
  UNIQUE (revision_id, duty_date, position),
  UNIQUE (revision_id, duty_date, staff_id)
);
-- Per ACTIVE revision: one person per (date, position), one position per (date, person).
CREATE UNIQUE INDEX uq_active_date_position ON assignments (duty_date, position) WHERE is_active = 1;
CREATE UNIQUE INDEX uq_active_date_staff    ON assignments (duty_date, staff_id) WHERE is_active = 1;

CREATE TABLE action_states (
  id            INTEGER PRIMARY KEY,
  assignment_id INTEGER NOT NULL REFERENCES assignments (id),
  action_kind   TEXT NOT NULL CHECK (action_kind IN ('ACK', 'AM', 'PM')),
  revision      INTEGER NOT NULL DEFAULT 1,    -- carried in postback data
  state         TEXT NOT NULL DEFAULT 'PENDING'
                CHECK (state IN ('PENDING', 'COMPLETED', 'EXPIRED', 'CANCELLED')),
  outcome       TEXT CHECK (outcome IN ('on_time', 'late')),
  opens_at      INTEGER NOT NULL,              -- initial send time (window start)
  late_after_at INTEGER NOT NULL,              -- opens_at + lateAfterMinutes
  cutoff_at     INTEGER NOT NULL,
  completed_at  INTEGER,                       -- user acted
  updated_at    INTEGER NOT NULL,
  UNIQUE (assignment_id, action_kind),
  CHECK ((state = 'COMPLETED') = (outcome IS NOT NULL)),
  CHECK ((state = 'COMPLETED') = (completed_at IS NOT NULL))
);

CREATE TABLE notification_jobs (
  id                  INTEGER PRIMARY KEY,
  assignment_id       INTEGER NOT NULL REFERENCES assignments (id),
  action_kind         TEXT NOT NULL CHECK (action_kind IN ('ACK', 'AM', 'PM')),
  phase               TEXT NOT NULL CHECK (phase IN ('INITIAL', 'REMINDER')),
  revision            INTEGER NOT NULL DEFAULT 1,
  status              TEXT NOT NULL DEFAULT 'QUEUED'
                      CHECK (status IN ('QUEUED', 'LEASED', 'API_ACCEPTED', 'RETRY_WAIT',
                                        'FAILED', 'SUPPRESSED', 'CANCELLED')),
  next_attempt_at     INTEGER NOT NULL,
  deadline_at         INTEGER NOT NULL,        -- never send after this
  attempts            INTEGER NOT NULL DEFAULT 0,
  lease_owner         TEXT,
  lease_until         INTEGER,
  -- Pinned before the first attempt, reused on every retry.
  target_line_user_id TEXT,
  payload             TEXT,
  retry_key           TEXT,
  -- Result of the LINE API call (accepted != delivered != user acted).
  api_accepted_at     INTEGER,
  line_request_id     TEXT,
  last_error          TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (assignment_id, action_kind, phase, revision),
  CHECK ((status = 'API_ACCEPTED') = (api_accepted_at IS NOT NULL))
);
CREATE INDEX idx_jobs_due ON notification_jobs (status, next_attempt_at);

CREATE TABLE webhook_events (
  webhook_event_id TEXT PRIMARY KEY,           -- dedupe key from LINE
  received_at      INTEGER NOT NULL,
  event_type       TEXT NOT NULL,
  outcome          TEXT
);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY,
  at         INTEGER NOT NULL,
  actor      TEXT NOT NULL,                    -- 'admin' | 'scheduler' | 'webhook'
  event      TEXT NOT NULL,
  detail     TEXT                              -- JSON
);
