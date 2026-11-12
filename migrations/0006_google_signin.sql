-- Google sign-in replaces one-time link codes (members) and passwords (admins).
-- Emails are stored lower-case. A member links LINE by signing in with the Google account whose email is on the roster.

ALTER TABLE members ADD COLUMN email TEXT;
CREATE UNIQUE INDEX members_email ON members (email) WHERE email IS NOT NULL;

-- Admins sign in with Google; username stays as the display key (set to the email for Google-created accounts).
-- password_hash is '' for Google-only accounts (never matches). Password login is a break-glass option (ALLOW_PASSWORD_LOGIN=1).
ALTER TABLE admin_users ADD COLUMN email TEXT;
CREATE UNIQUE INDEX admin_users_email ON admin_users (email) WHERE email IS NOT NULL;

-- One row per Google sign-in in progress. Only the SHA-256 of `state` is stored. Single use, short-lived.
-- purpose 'member': started from the LIFF link page; line_user_id is the LINE-verified user to link.
-- purpose 'admin':  started from /login; also bound to the browser by a cookie (login CSRF).
CREATE TABLE oauth_states (
  state_hash    TEXT PRIMARY KEY,
  purpose       TEXT NOT NULL CHECK (purpose IN ('member', 'admin')),
  line_user_id  TEXT,
  code_verifier TEXT NOT NULL, -- PKCE
  next_path     TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  used_at       INTEGER
);
CREATE INDEX oauth_states_expiry ON oauth_states (expires_at);
