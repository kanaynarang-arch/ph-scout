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

-- Limits for sending a copy of the list to Kavya: one control row per limit key (Generate: the namespace; send buttons: namespace:send:telegram and namespace:send:email).
-- Claimed atomically with a single INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING. Holds no message text and no addresses.
CREATE TABLE IF NOT EXISTS notify_control (
  key text PRIMARY KEY,
  last_sent_at timestamptz
);
