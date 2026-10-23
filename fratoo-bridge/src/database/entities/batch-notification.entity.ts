import { Column, Entity, PrimaryColumn } from 'typeorm';

// An alert that went out for a batch (db/init/004_push.sql, 005_alerts.sql).
// One-off kinds fire once; on/off kinds (device_offline, temp_high,
// temp_low) set `active` while the problem lasts and clear it when the
// "resolved" notification goes out.
@Entity({ name: 'batch_notifications' })
export class BatchNotificationEntity {
  @PrimaryColumn({ name: 'batch_id', type: 'integer' })
  batchId: number;

  @PrimaryColumn({ type: 'varchar', length: 32 })
  kind: string;

  @Column({ name: 'sent_at', type: 'timestamptz' })
  sentAt: Date;

  @Column({ type: 'boolean', default: false })
  active: boolean;

  @Column({ name: 'cleared_at', type: 'timestamptz', nullable: true })
  clearedAt: Date | null;
}
