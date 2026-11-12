-- Email notifications and the member portal.

-- Each outbox row goes out on ONE channel. Email rows use the LINE keys with an "E" prefix
-- (ER:<member>:<date>, EP:<duty>, EM:<duty>, EC:<duty>), so both channels keep "never send twice".
-- For email rows, target_user_id holds the address and line_request_id the SMTP Message-ID.
ALTER TABLE outbox ADD COLUMN channel TEXT NOT NULL DEFAULT 'line' CHECK (channel IN ('line', 'email'));

-- Where a check-in attempt came from: 'liff' (inside LINE) or 'web' (member portal, Google session).
ALTER TABLE checkins ADD COLUMN via TEXT;

-- Member portal sessions (Google sign-in with the roster email). Only the SHA-256 of the token is stored.
CREATE TABLE member_sessions (
  token_hash   TEXT PRIMARY KEY,
  member_id    INTEGER NOT NULL REFERENCES members (id),
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip_hash      TEXT,
  user_agent   TEXT
);
CREATE INDEX member_sessions_member ON member_sessions (member_id);

-- New sign-in purpose 'portal'. SQLite cannot alter a CHECK; rows here live 10 minutes, so recreate the table.
DROP TABLE oauth_states;
CREATE TABLE oauth_states (
  state_hash    TEXT PRIMARY KEY,
  purpose       TEXT NOT NULL CHECK (purpose IN ('member', 'admin', 'portal')),
  line_user_id  TEXT,
  code_verifier TEXT NOT NULL, -- PKCE
  next_path     TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  used_at       INTEGER
);
CREATE INDEX oauth_states_expiry ON oauth_states (expires_at);
