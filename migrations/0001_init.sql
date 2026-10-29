-- v2 schema. Instants are UTC epoch ms (INTEGER). Duty dates are Bangkok 'YYYY-MM-DD' (TEXT).

CREATE TABLE members (
  id           INTEGER PRIMARY KEY,
  staff_code   TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL,
  grp          TEXT,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  line_user_id TEXT,
  linked_at    INTEGER,
  consent_at   INTEGER,
  created_at   INTEGER NOT NULL
);
-- One member per LINE account (and one LINE account per member, since line_user_id is a single column).
CREATE UNIQUE INDEX members_line_user ON members (line_user_id) WHERE line_user_id IS NOT NULL;

CREATE TABLE link_codes (
  id         INTEGER PRIMARY KEY,
  member_id  INTEGER NOT NULL REFERENCES members (id),
  code_hash  TEXT NOT NULL UNIQUE, -- SHA-256 hex; the code itself is never stored
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  revoked_at INTEGER
);
CREATE INDEX link_codes_member ON link_codes (member_id);

CREATE TABLE locations (
  id                 INTEGER PRIMARY KEY,
  code               TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  allowed_accuracy_m INTEGER NOT NULL CHECK (allowed_accuracy_m > 0),
  active             INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

-- A check-in passes if it is inside ANY point of the location (multi-building sites).
CREATE TABLE geofence_points (
  id          INTEGER PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations (id),
  label       TEXT,
  lat         REAL NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng         REAL NOT NULL CHECK (lng BETWEEN -180 AND 180),
  radius_m    INTEGER NOT NULL CHECK (radius_m > 0)
);
CREATE INDEX geofence_points_location ON geofence_points (location_id);

CREATE TABLE import_batches (
  id           INTEGER PRIMARY KEY,
  status       TEXT NOT NULL CHECK (status IN ('STAGED', 'PUBLISHED', 'DISCARDED')),
  content_hash TEXT NOT NULL,
  rows_json    TEXT NOT NULL, -- normalized rows, revalidated server-side
  dates_json   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  published_at INTEGER
);

-- Dates some published batch covered. A date absent here is UNKNOWN, never "no duty".
CREATE TABLE roster_dates (
  duty_date TEXT PRIMARY KEY,
  batch_id  INTEGER NOT NULL REFERENCES import_batches (id)
);

CREATE TABLE duties (
  id              INTEGER PRIMARY KEY,
  member_id       INTEGER NOT NULL REFERENCES members (id),
  location_id     INTEGER NOT NULL REFERENCES locations (id),
  duty_date       TEXT NOT NULL,
  shift           TEXT NOT NULL,
  start_at        INTEGER NOT NULL,
  end_at          INTEGER NOT NULL CHECK (end_at > start_at),
  status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CHECKED_IN', 'MISSED', 'CANCELLED')),
  checked_in_at   INTEGER,
  late            INTEGER CHECK (late IN (0, 1)),
  source          TEXT CHECK (source IN ('gps', 'override')),
  override_note   TEXT,
  override_by     TEXT,
  import_batch_id INTEGER REFERENCES import_batches (id),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX duties_live ON duties (member_id, duty_date, shift) WHERE status != 'CANCELLED';
CREATE INDEX duties_date ON duties (duty_date, status);
CREATE INDEX duties_member_start ON duties (member_id, start_at);
CREATE INDEX duties_open ON duties (status, end_at);

CREATE TABLE nonces (
  id         INTEGER PRIMARY KEY,
  duty_id    INTEGER NOT NULL REFERENCES duties (id),
  member_id  INTEGER NOT NULL REFERENCES members (id),
  value      TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);

-- Every check-in attempt, whatever the outcome, for audit.
CREATE TABLE checkins (
  id           INTEGER PRIMARY KEY,
  duty_id      INTEGER REFERENCES duties (id),
  member_id    INTEGER REFERENCES members (id),
  submitted_at INTEGER NOT NULL, -- server time
  client_ts    INTEGER,          -- stored for anomaly checks, never trusted
  lat          REAL,             -- nulled after config.locationRetentionDays
  lng          REAL,
  accuracy_m   REAL,
  distance_m   REAL,             -- to the nearest geofence point centre
  point_id     INTEGER REFERENCES geofence_points (id),
  result       TEXT NOT NULL CHECK (result IN ('ok', 'outside_geofence', 'low_accuracy', 'outside_window', 'rejected')),
  reason       TEXT,
  nonce_id     INTEGER REFERENCES nonces (id),
  ip_hash      TEXT,
  user_agent   TEXT
);
CREATE INDEX checkins_member ON checkins (member_id, submitted_at);
CREATE INDEX checkins_duty ON checkins (duty_id);
CREATE INDEX checkins_time ON checkins (submitted_at);

-- Push outbox (the spec's message_log). dedupe_key makes "never send twice" a constraint:
-- REMINDER R:<member>:<date>, PROMPT P:<duty>, MISSED M:<duty>.
CREATE TABLE outbox (
  id              INTEGER PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('REMINDER', 'PROMPT', 'MISSED')),
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
  accepted_at     INTEGER, -- LINE API accepted the push. Says nothing about the user reading it.
  line_request_id TEXT,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX outbox_due ON outbox (status, next_attempt_at);
CREATE INDEX outbox_date ON outbox (duty_date);
CREATE INDEX outbox_duty ON outbox (duty_id);

CREATE TABLE webhook_events (
  webhook_event_id TEXT PRIMARY KEY,
  received_at      INTEGER NOT NULL,
  event_type       TEXT NOT NULL,
  outcome          TEXT NOT NULL
);

CREATE TABLE audit_log (
  id     INTEGER PRIMARY KEY,
  at     INTEGER NOT NULL,
  actor  TEXT NOT NULL,
  event  TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE scheduler_heartbeat (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  last_run_at  INTEGER NOT NULL,
  last_summary TEXT
);
