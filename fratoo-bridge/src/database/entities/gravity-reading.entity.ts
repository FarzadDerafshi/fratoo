import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// A manual hydrometer (SG) or refractometer (Brix) reading taken during a
// batch — the ground truth the ABV model calibrates its bubble volume
// against. Unlike readings, these DO have a real FK to their batch (ON
// DELETE CASCADE in db/init/002_abv_calibration.sql): they're entered per
// batch, not derived from a device time window.
@Entity({ name: 'gravity_readings' })
@Index('idx_gravity_batch', ['batchId', 'measuredAt'])
export class GravityReadingEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'batch_id', type: 'integer' })
  batchId: number;

  @Column({ name: 'measured_at', type: 'timestamptz' })
  measuredAt: Date;

  /** As read off the instrument — SG (e.g. 1.012) or raw Brix (e.g. 6.4, not yet corrected). */
  @Column({ type: 'double precision' })
  value: number;

  @Column({ type: 'varchar', length: 8 })
  unit: 'sg' | 'brix';

  /** Keeps a suspect reading on record without letting it skew the calibration. */
  @Column({ name: 'exclude_from_calibration', type: 'boolean', default: false })
  excludeFromCalibration: boolean;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
