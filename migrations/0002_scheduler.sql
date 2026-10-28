-- Expiry sweep: PENDING actions whose cutoff has passed.
CREATE INDEX idx_actions_pending ON action_states (state, cutoff_at);

-- Single-row liveness record, written at the end of every successful scheduled() run.
CREATE TABLE scheduler_heartbeat (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  last_run_at  INTEGER NOT NULL,
  last_summary TEXT
);
