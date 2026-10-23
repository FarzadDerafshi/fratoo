-- Push notifications (Web Push, works in the installed app incl. iPhone
-- home-screen apps on iOS 16.4+). See ProjectDocs/DECISIONS.md "Push
-- notifications".
--
-- Idempotent like 002/003: runs automatically on a brand-new volume, and
-- ProdRelease.bat re-applies it on every deploy to an existing one.

-- One row per device/browser that turned notifications on. The endpoint is
-- the push service URL (Apple/Google/Mozilla) for that installation.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id              SERIAL PRIMARY KEY,
  endpoint        TEXT NOT NULL UNIQUE,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_success_at TIMESTAMPTZ
);

-- Which alert already went out for which batch, so each fires once
-- ('fermentation_started', later e.g. 'device_offline').
CREATE TABLE IF NOT EXISTS batch_notifications (
  batch_id INTEGER NOT NULL REFERENCES batches (id) ON DELETE CASCADE,
  kind     VARCHAR(32) NOT NULL,
  sent_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, kind)
);
