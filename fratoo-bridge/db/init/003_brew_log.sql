-- Brew log: what went into the fermenter (yeast, pitch, hops), what came
-- out of it (bottling, tasting), and timestamped events (dry hop, bottling,
-- disturbances) shown on the chart and in the report. See
-- ProjectDocs/DECISIONS.md "Brew log fields and batch events".
--
-- Idempotent like 002: runs automatically on a brand-new volume, and
-- ProdRelease.bat re-applies it on every deploy to an existing one.

ALTER TABLE batches ADD COLUMN IF NOT EXISTS yeast_strain VARCHAR(128);
-- The strain's typical apparent attenuation on malt wort, in percent (e.g.
-- 78). Drives the "expected ABV" mark; the app-wide setting is the fallback.
ALTER TABLE batches ADD COLUMN IF NOT EXISTS yeast_attenuation DOUBLE PRECISION;
-- When the yeast went in (can be hours after the batch started) — the lag
-- phase is measured from here when set.
ALTER TABLE batches ADD COLUMN IF NOT EXISTS pitched_at TIMESTAMPTZ;
ALTER TABLE batches ADD COLUMN IF NOT EXISTS pitch_temp_c DOUBLE PRECISION;
-- Free text: hop varieties, amounts and timing, incl. dry hop.
ALTER TABLE batches ADD COLUMN IF NOT EXISTS hops TEXT;
-- Bottling: priming sugar (g, sucrose) dissolved into the bottled volume.
-- bottled_volume_l falls back to volume_liters when empty.
ALTER TABLE batches ADD COLUMN IF NOT EXISTS priming_sugar_g DOUBLE PRECISION;
ALTER TABLE batches ADD COLUMN IF NOT EXISTS bottled_volume_l DOUBLE PRECISION;
ALTER TABLE batches ADD COLUMN IF NOT EXISTS bottle_count INTEGER;
ALTER TABLE batches ADD COLUMN IF NOT EXISTS tasting_notes TEXT;

CREATE TABLE IF NOT EXISTS batch_events (
  id          SERIAL PRIMARY KEY,
  batch_id    INTEGER NOT NULL REFERENCES batches (id) ON DELETE CASCADE,
  occurred_at TIMESTAMPTZ NOT NULL,
  -- 'dry_hop' | 'addition' | 'temperature' | 'disturbance' | 'bottling' | 'other'
  kind        VARCHAR(16) NOT NULL,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_batch_events_batch ON batch_events (batch_id, occurred_at);
