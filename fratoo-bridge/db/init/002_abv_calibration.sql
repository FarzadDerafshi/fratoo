-- ABV calibration model: original gravity on batches, hydrometer/refractometer
-- gravity readings, and app-wide fermentation-model settings. See
-- ProjectDocs/DECISIONS.md "Calibrated bubble-volume ABV model".
--
-- Idempotent on purpose (IF NOT EXISTS everywhere): the Postgres image runs
-- it automatically after 001 on a brand-new volume, and on an existing
-- volume (production) it has to be applied by hand — ProdRelease.bat does
-- that on every deploy, so re-running it must always be a no-op.

ALTER TABLE batches ADD COLUMN IF NOT EXISTS og_value DOUBLE PRECISION;
-- 'sg' or 'brix' — the raw entry is kept as typed so changing the wort
-- correction factor later re-derives the SG instead of baking in today's.
ALTER TABLE batches ADD COLUMN IF NOT EXISTS og_unit VARCHAR(8);
-- Whether the OG was measured after the added sugar was dissolved. When
-- false, added_sugar_g is converted to gravity points and added on top.
ALTER TABLE batches ADD COLUMN IF NOT EXISTS og_includes_sugar BOOLEAN NOT NULL DEFAULT TRUE;
-- The brewer's own expectation (kit instructions / experience) — display
-- and comparison only, never used in the model.
ALTER TABLE batches ADD COLUMN IF NOT EXISTS target_abv DOUBLE PRECISION;
-- Manual per-batch bubble volume; overrides every other source when set.
ALTER TABLE batches ADD COLUMN IF NOT EXISTS bubble_volume_ml DOUBLE PRECISION;
-- Cached result of fitting this batch's own gravity readings (recomputed
-- whenever readings, batch fields or settings change) — lets other batches
-- learn from it without re-reading every telemetry row.
ALTER TABLE batches ADD COLUMN IF NOT EXISTS calibrated_bubble_volume_ml DOUBLE PRECISION;
ALTER TABLE batches ADD COLUMN IF NOT EXISTS calibration_points INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS gravity_readings (
  id                       SERIAL PRIMARY KEY,
  batch_id                 INTEGER NOT NULL REFERENCES batches (id) ON DELETE CASCADE,
  measured_at              TIMESTAMPTZ NOT NULL,
  value                    DOUBLE PRECISION NOT NULL,
  unit                     VARCHAR(8) NOT NULL, -- 'sg' or 'brix'
  exclude_from_calibration BOOLEAN NOT NULL DEFAULT FALSE,
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gravity_batch ON gravity_readings (batch_id, measured_at);

CREATE TABLE IF NOT EXISTS app_settings (
  key        VARCHAR(64) PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
