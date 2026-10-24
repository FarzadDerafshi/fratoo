-- Known airlocks (2.7.0): one row per device token, with a name you pick, so
-- a new batch picks its airlock from a list instead of a pasted 32-character
-- token. Rows are added automatically when a new token sends its first
-- reading (DevicesService), or by hand in Settings → Airlocks.
--
-- Idempotent like 002–005: runs automatically on a brand-new volume, and
-- ProdRelease.bat re-applies it on every deploy to an existing one.
--
-- The table is created and backfilled from the devices already in readings
-- and batches in one go, only when it doesn't exist yet — so an airlock
-- removed in Settings doesn't come back with every later deploy (one that's
-- still sending comes back by itself with its next reading).
DO $$
BEGIN
  IF to_regclass('public.devices') IS NULL THEN
    CREATE TABLE devices (
      device_id   VARCHAR(64) PRIMARY KEY,
      name        VARCHAR(64) NOT NULL DEFAULT '',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    INSERT INTO devices (device_id, created_at)
    SELECT device_id, min(t) FROM (
      SELECT device_id, recorded_at AS t FROM readings WHERE device_id <> ''
      UNION ALL
      SELECT device_id, started_at FROM batches WHERE device_id <> ''
    ) seen
    GROUP BY device_id;
  END IF;
END $$;
