-- Real admin login (replaces the stub bearer token). Passwords are PBKDF2-SHA256; sessions are random tokens
-- whose SHA-256 is stored (a DB leak does not leak usable session ids).

CREATE TABLE admin_users (
  id                  INTEGER PRIMARY KEY,
  username            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name        TEXT NOT NULL,
  password_hash       TEXT NOT NULL, -- pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>
  must_change         INTEGER NOT NULL DEFAULT 1 CHECK (must_change IN (0, 1)),
  failed_count        INTEGER NOT NULL DEFAULT 0,
  locked_until        INTEGER,
  disabled            INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  created_at          INTEGER NOT NULL,
  password_changed_at INTEGER
);

CREATE TABLE admin_sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES admin_users (id),
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL, -- absolute limit
  last_seen_at INTEGER NOT NULL, -- idle limit
  ip_hash      TEXT,
  user_agent   TEXT
);
CREATE INDEX admin_sessions_user ON admin_sessions (user_id);
CREATE INDEX admin_sessions_expiry ON admin_sessions (expires_at);
