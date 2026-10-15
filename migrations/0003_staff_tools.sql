-- Tags on a customer: JSON array of lowercase strings, e.g. ["vip","kyc"].
ALTER TABLE conversations ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';

-- Photos, documents, voice notes... (Meta media id; fetched through the gateway on demand).
ALTER TABLE chat_messages ADD COLUMN media_id TEXT;
ALTER TABLE chat_messages ADD COLUMN media_mime TEXT;
ALTER TABLE chat_messages ADD COLUMN media_name TEXT;

-- Internal staff notes; never sent to the customer.
CREATE TABLE staff_notes (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_staff_notes_phone ON staff_notes (phone, created_at);

-- Saved answers for the composer. site_id NULL = every site.
CREATE TABLE quick_replies (
  id TEXT PRIMARY KEY,
  site_id TEXT,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- One row per "talk to a person" request: response times, escalation alerts.
CREATE TABLE support_requests (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  site_id TEXT NOT NULL,
  message TEXT,
  requested_at INTEGER NOT NULL,
  first_reply_at INTEGER,
  first_reply_by TEXT,
  escalated_at INTEGER,
  resolved_at INTEGER
);
CREATE INDEX idx_support_open ON support_requests (phone, resolved_at);
CREATE INDEX idx_support_requested ON support_requests (requested_at);
