-- One row per customer on the shared number: what the dashboard inbox lists.
CREATE TABLE conversations (
  phone TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  name TEXT,
  -- bot: bot answers | needs_help: customer asked for a person | agent: staff is replying
  mode TEXT NOT NULL DEFAULT 'bot',
  mode_at INTEGER NOT NULL,
  assigned_to TEXT,
  last_text TEXT,
  last_author TEXT,
  last_message_at INTEGER NOT NULL,
  -- Free-form replies are only allowed within 24 h of this (Meta customer service window).
  last_inbound_at INTEGER,
  unread INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_conversations_last ON conversations (last_message_at);
CREATE INDEX idx_conversations_mode ON conversations (mode, last_message_at);

-- Full transcript: customer messages, bot / staff / website replies, campaigns.
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  site_id TEXT NOT NULL,
  direction TEXT NOT NULL,      -- in | out
  author TEXT NOT NULL,         -- customer | bot | agent | system | campaign
  agent TEXT,                   -- staff name for author = agent
  type TEXT NOT NULL,
  text TEXT,
  status TEXT,                  -- outbound: accepted | sent | delivered | read | failed
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_chat_phone ON chat_messages (phone, created_at);
CREATE INDEX idx_chat_created ON chat_messages (created_at);
