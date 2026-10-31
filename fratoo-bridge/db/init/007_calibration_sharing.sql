-- Calibration sharing (2.8.0): whether a batch's own bubble-volume fit joins
-- the learned value other batches start from. Off keeps an odd batch's fit
-- (a different airlock fill, a leaky lid) to itself, while the batch still
-- uses it. See ProjectDocs/DECISIONS.md "Calibration sharing".
--
-- Idempotent like 002–006: runs automatically on a brand-new volume, and
-- ProdRelease.bat re-applies it on every deploy to an existing one.
ALTER TABLE batches ADD COLUMN IF NOT EXISTS share_calibration BOOLEAN NOT NULL DEFAULT true;
