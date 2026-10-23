import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// Mirrors wp_fratoo_readings from the WordPress plugin (see
// ProjectDocs/ARCHITECTURE.md). Column names stay snake_case to match the
// SQL in db/init/001_init_fratoo.sql exactly.
@Entity({ name: 'readings' })
@Index('idx_device_time', ['deviceId', 'recordedAt'])
export class ReadingEntity {
  // Plain int4 PK (not bigint) — at ~3 readings/~5min cycle this device
  // produces well under a million rows/year, nowhere near int4's ~2.1B
  // ceiling, and it avoids TypeORM's string-typed bigint IDs everywhere.
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'device_id', type: 'varchar', length: 64 })
  deviceId: string;

  @Column({ type: 'varchar', length: 8 })
  pin: string;

  @Column({ type: 'double precision' })
  value: number;

  @Column({ name: 'bubble_rate', type: 'double precision', default: 0 })
  bubbleRate: number;

  // TIMESTAMPTZ so the DB is explicit about UTC storage (matches the
  // bridge's `new Date()` behavior) — the frontend renders local time.
  @Column({ name: 'recorded_at', type: 'timestamptz' })
  recordedAt: Date;
}
