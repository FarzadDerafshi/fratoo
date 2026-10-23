-- Initial schema for the standalone Fratoo backend (Postgres).
-- Mirrors wp_fratoo_readings / wp_fratoo_batches from the WordPress plugin
-- it replaced — see ProjectDocs/ARCHITECTURE.md and ProjectDocs/DECISIONS.md.
--
-- Run automatically by the official postgres Docker image on a brand-new,
-- empty data volume (anything mounted at /docker-entrypoint-initdb.d).
-- It does NOT run again on a volume that already has data — later schema
-- changes are their own numbered, idempotent files, which ProdRelease.bat
-- applies on every deploy (see ProjectDocs/DEPLOYMENT.md "Database migrations").

CREATE TABLE readings (
  id          SERIAL PRIMARY KEY,
  device_id   VARCHAR(64) NOT NULL,
  pin         VARCHAR(8)  NOT NULL,
  value       DOUBLE PRECISION NOT NULL,
  bubble_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  recorded_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_device_time ON readings (device_id, recorded_at);

CREATE TABLE batches (
  id             SERIAL PRIMARY KEY,
  batch_code     VARCHAR(64) NOT NULL,
  device_id      VARCHAR(64) NOT NULL DEFAULT '',
  brew_type      VARCHAR(32) NOT NULL DEFAULT 'beer',
  status         VARCHAR(16) NOT NULL DEFAULT 'active',
  -- double precision, not NUMERIC: node-postgres returns NUMERIC columns as
  -- strings (to avoid float precision loss on financial-grade data), which
  -- these aren't -- human-entered volume/sugar values -- and that string
  -- vs number mismatch is exactly the kind of bug that's easy to miss until
  -- it corrupts a downstream calculation. See ProjectDocs/DECISIONS.md.
  volume_liters  DOUBLE PRECISION,
  added_sugar_g  DOUBLE PRECISION,
  notes          TEXT,
  started_at     TIMESTAMPTZ NOT NULL,
  ended_at       TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_status ON batches (status);
CREATE INDEX idx_device ON batches (device_id);
CREATE INDEX idx_started ON batches (started_at);
