import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// Mirrors wp_fratoo_batches from the WordPress plugin (see
// ProjectDocs/ARCHITECTURE.md). No FK to ReadingEntity — "the readings for
// this batch" is always a derived device_id + time-window query, same as
// the WP plugin's resolve_batch_window(). See BatchesService.
@Entity({ name: 'batches' })
export class BatchEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'batch_code', type: 'varchar', length: 64 })
  batchCode: string;

  @Index('idx_device')
  @Column({ name: 'device_id', type: 'varchar', length: 64, default: '' })
  deviceId: string;

  @Column({ name: 'brew_type', type: 'varchar', length: 32, default: 'beer' })
  brewType: string;

  @Index('idx_status')
  @Column({ type: 'varchar', length: 16, default: 'active' })
  status: string;

  // double precision, not 'numeric' — see db/init/001_init_fratoo.sql for why
  // (node-postgres returns NUMERIC as a string, which these aren't built to
  // handle — see ProjectDocs/DECISIONS.md).
  @Column({ name: 'volume_liters', type: 'double precision', nullable: true })
  volumeLiters: number | null;

  @Column({ name: 'added_sugar_g', type: 'double precision', nullable: true })
  addedSugarG: number | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  // ABV model inputs — see db/init/002_abv_calibration.sql and
  // src/fermentation/abv-model.ts. og_value is kept exactly as entered
  // (SG or Brix), so a changed wort correction factor re-derives the SG.
  @Column({ name: 'og_value', type: 'double precision', nullable: true })
  ogValue: number | null;

  @Column({ name: 'og_unit', type: 'varchar', length: 8, nullable: true })
  ogUnit: 'sg' | 'brix' | null;

  @Column({ name: 'og_includes_sugar', type: 'boolean', default: true })
  ogIncludesSugar: boolean;

  @Column({ name: 'target_abv', type: 'double precision', nullable: true })
  targetAbv: number | null;

  /** Manual per-batch bubble volume override (mL). */
  @Column({ name: 'bubble_volume_ml', type: 'double precision', nullable: true })
  bubbleVolumeMl: number | null;

  /** Cached fit from this batch's own gravity readings — maintained by FermentationService.recalibrate(), never set directly. */
  @Column({ name: 'calibrated_bubble_volume_ml', type: 'double precision', nullable: true })
  calibratedBubbleVolumeMl: number | null;

  @Column({ name: 'calibration_points', type: 'integer', default: 0 })
  calibrationPoints: number;

  /** Whether this batch's fit joins the learned bubble volume other batches start from (db/init/007_calibration_sharing.sql). */
  @Column({ name: 'share_calibration', type: 'boolean', default: true })
  shareCalibration: boolean;

  // Brew log — see db/init/003_brew_log.sql.
  @Column({ name: 'yeast_strain', type: 'varchar', length: 128, nullable: true })
  yeastStrain: string | null;

  /** Typical apparent attenuation of the strain on malt wort, percent (e.g. 78). */
  @Column({ name: 'yeast_attenuation', type: 'double precision', nullable: true })
  yeastAttenuation: number | null;

  @Column({ name: 'pitched_at', type: 'timestamptz', nullable: true })
  pitchedAt: Date | null;

  @Column({ name: 'pitch_temp_c', type: 'double precision', nullable: true })
  pitchTempC: number | null;

  @Column({ type: 'text', nullable: true })
  hops: string | null;

  @Column({ name: 'priming_sugar_g', type: 'double precision', nullable: true })
  primingSugarG: number | null;

  /** Falls back to volumeLiters when null. */
  @Column({ name: 'bottled_volume_l', type: 'double precision', nullable: true })
  bottledVolumeL: number | null;

  @Column({ name: 'bottle_count', type: 'integer', nullable: true })
  bottleCount: number | null;

  @Column({ name: 'tasting_notes', type: 'text', nullable: true })
  tastingNotes: string | null;

  // Temperature alert limits for this batch, °C at the airlock (db/init/005_alerts.sql).
  // NULL = the app-wide notification settings.
  @Column({ name: 'alert_temp_min_c', type: 'double precision', nullable: true })
  alertTempMinC: number | null;

  @Column({ name: 'alert_temp_max_c', type: 'double precision', nullable: true })
  alertTempMaxC: number | null;

  @Index('idx_started')
  @Column({ name: 'started_at', type: 'timestamptz' })
  startedAt: Date;

  @Column({ name: 'ended_at', type: 'timestamptz', nullable: true })
  endedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
