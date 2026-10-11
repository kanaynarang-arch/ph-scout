-- Idempotent. Stores only public Product Hunt launch data, maker-comment counts and Gemini outputs.
CREATE TABLE IF NOT EXISTS cache_entries (
  key text PRIMARY KEY,
  value jsonb,
  fetched_at timestamptz,
  expires_at timestamptz
);
CREATE INDEX IF NOT EXISTS cache_entries_expires_idx ON cache_entries (expires_at);

-- First time the app saw each launch (powers the display-only "New since your last visit" tag).
CREATE TABLE IF NOT EXISTS launch_seen (
  launch_id text PRIMARY KEY,
  first_seen_at timestamptz DEFAULT now()
);

-- Limits for the auto-send of a copy of the list to Kavya (one control row per cache namespace).
-- Claimed atomically with a single conditional UPDATE ... RETURNING. Holds no message text and no addresses.
CREATE TABLE IF NOT EXISTS notify_control (
  key text PRIMARY KEY,
  last_sent_at timestamptz,
  day date,
  day_count integer NOT NULL DEFAULT 0
);

-- Small audit log of send attempts: time, status and per-channel result only.
CREATE TABLE IF NOT EXISTS notify_log (
  id bigserial PRIMARY KEY,
  at timestamptz DEFAULT now(),
  key text,
  status text NOT NULL,
  telegram text,
  email text,
  row_count integer
);
