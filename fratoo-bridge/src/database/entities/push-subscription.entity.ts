import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

// A device/browser that turned push notifications on (db/init/004_push.sql).
// Rows are removed when the push service says the subscription is gone.
@Entity({ name: 'push_subscriptions' })
export class PushSubscriptionEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'text', unique: true })
  endpoint: string;

  @Column({ type: 'text' })
  p256dh: string;

  @Column({ type: 'text' })
  auth: string;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'last_success_at', type: 'timestamptz', nullable: true })
  lastSuccessAt: Date | null;
}
