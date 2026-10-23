-- More push alerts (2.6.0): device offline / back online, no start,
-- temperature, peak passed, looks finished, stalled, device rebooted. See
-- ProjectDocs/DECISIONS.md "Push alerts".
--
-- Idempotent like 002–004: runs automatically on a brand-new volume, and
-- ProdRelease.bat re-applies it on every deploy to an existing one.

-- Alerts that can go on and off (offline → back online, temperature high →
-- back in range) keep their state on the same row: active = the "problem"
-- notification went out and the "resolved" one hasn't yet. One-off alerts
-- (fermentation started, peak passed, …) just keep active = false.
ALTER TABLE batch_notifications ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE batch_notifications ADD COLUMN IF NOT EXISTS cleared_at TIMESTAMPTZ;

-- Per-batch temperature alert limits (°C at the airlock); NULL = the
-- app-wide notification settings.
ALTER TABLE batches ADD COLUMN IF NOT EXISTS alert_temp_min_c DOUBLE PRECISION;
ALTER TABLE batches ADD COLUMN IF NOT EXISTS alert_temp_max_c DOUBLE PRECISION;
