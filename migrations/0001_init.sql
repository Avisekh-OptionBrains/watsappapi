-- Inbound Meta message ids already handled (webhook retries are safe).
CREATE TABLE processed_messages (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_processed_created ON processed_messages (created_at);

-- Every message accepted by Meta, so delivery receipts can be routed to the right site.
CREATE TABLE outbound_messages (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  kind TEXT NOT NULL,
  preview TEXT,
  campaign_id TEXT,
  status TEXT NOT NULL DEFAULT 'accepted',
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_outbound_created ON outbound_messages (created_at);

-- Marketing consent per site. site_id '*' is the WhatsApp-wide STOP / START switch.
CREATE TABLE consents (
  site_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  opted_in INTEGER NOT NULL,
  source TEXT NOT NULL,
  purpose TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, phone)
);

-- Which brand a customer last chose on the shared number.
CREATE TABLE phone_sites (
  phone TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Short-lived bot conversation state.
CREATE TABLE bot_sessions (
  phone TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  state TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE handoffs (
  site_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  assigned_to TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, phone)
);

CREATE TABLE campaigns (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  name TEXT NOT NULL,
  template_name TEXT NOT NULL,
  language TEXT NOT NULL,
  category TEXT NOT NULL,
  components TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_campaigns_site ON campaigns (site_id, created_at);

CREATE TABLE campaign_recipients (
  campaign_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  message_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, phone)
);
CREATE INDEX idx_recipients_message ON campaign_recipients (message_id);

-- Normalised site catalog (plans, portfolios, hosting...) cached for the bot and /v1/catalog.
CREATE TABLE catalog_cache (
  site_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
