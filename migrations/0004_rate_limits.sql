-- Fixed-window counters, e.g. sign-in codes per phone. Websites trust the gateway's limits.
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
CREATE INDEX idx_rate_limits_reset ON rate_limits (reset_at);
