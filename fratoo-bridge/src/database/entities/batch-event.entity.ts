import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export const BATCH_EVENT_KINDS = ['dry_hop', 'addition', 'temperature', 'disturbance', 'bottling', 'other'] as const;
export type BatchEventKind = (typeof BATCH_EVENT_KINDS)[number];

// Something the brewer did or noticed at a point in time — dry hop, moving
// the fermenter, bottling. Annotation only: drawn on the chart and listed in
// the report so a bump or a step in the bubble rate has an explanation; it
// never changes the ABV model. FK to the batch (ON DELETE CASCADE in
// db/init/003_brew_log.sql), like gravity readings.
@Entity({ name: 'batch_events' })
@Index('idx_batch_events_batch', ['batchId', 'occurredAt'])
export class BatchEventEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'batch_id', type: 'integer' })
  batchId: number;

  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt: Date;

  @Column({ type: 'varchar', length: 16 })
  kind: BatchEventKind;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
