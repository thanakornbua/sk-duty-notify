-- One-time binding codes. The user types the code in the private chat; the webhook supplies the userId.
CREATE TABLE binding_codes (
  id         INTEGER PRIMARY KEY,
  staff_id   TEXT NOT NULL REFERENCES people (staff_id),
  code       TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  revoked_at INTEGER                      -- set when a newer code is issued for the same staff
);
CREATE INDEX idx_binding_codes_staff ON binding_codes (staff_id);
