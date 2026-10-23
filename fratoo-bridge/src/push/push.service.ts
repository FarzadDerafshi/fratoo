import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import * as webpush from 'web-push';
import { DATA_SOURCE } from '../database/database.module';
import { AppSettingEntity } from '../database/entities/app-setting.entity';
import { PushSubscriptionEntity } from '../database/entities/push-subscription.entity';

/** What the service worker (fratoo-web/public/sw.js) shows. */
export interface PushPayload {
  title: string;
  body: string;
  /** Opened when the notification is tapped, e.g. /batches/7. */
  url?: string;
  /** Same tag = replaces the earlier notification instead of stacking. */
  tag?: string;
}

export interface PushResult {
  sent: number;
  removed: number;
  failed: number;
}

export interface SubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const VAPID_KEY = 'push_vapid';
/** Push services keep an undelivered message this long (phone off/offline), then drop it. */
const TTL_SECONDS = 24 * 3600;

/**
 * Web Push: VAPID keys, subscriptions, sending. The keys are generated on
 * first start and kept in app_settings, so deploying needs no new .env
 * entry — but regenerating them (e.g. wiping that row) invalidates every
 * subscription, and devices must turn notifications on again.
 */
@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private readonly settingsRepo: Repository<AppSettingEntity>;
  private readonly subscriptionRepo: Repository<PushSubscriptionEntity>;
  private publicKey = '';

  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {
    this.settingsRepo = this.dataSource.getRepository(AppSettingEntity);
    this.subscriptionRepo = this.dataSource.getRepository(PushSubscriptionEntity);
  }

  async onModuleInit(): Promise<void> {
    let row = await this.settingsRepo.findOne({ where: { key: VAPID_KEY } });
    if (!row) {
      const keys = webpush.generateVAPIDKeys();
      row = await this.settingsRepo.save({ key: VAPID_KEY, value: { ...keys } });
      this.logger.log('Generated VAPID keys for push notifications');
    }
    const { publicKey, privateKey } = row.value as { publicKey: string; privateKey: string };
    // Push services (Apple in particular) require a contact in the VAPID
    // token: a mailto: or https: URL. Override with PUSH_SUBJECT.
    const subject = this.config.get<string>('PUSH_SUBJECT') || 'https://github.com/FarzadDerafshi/fratoo';
    webpush.setVapidDetails(subject, publicKey, privateKey);
    this.publicKey = publicKey;
  }

  getPublicKey(): string {
    return this.publicKey;
  }

  countSubscriptions(): Promise<number> {
    return this.subscriptionRepo.count();
  }

  async subscribe(input: SubscriptionInput, userAgent: string | null): Promise<void> {
    await this.subscriptionRepo.upsert(
      { endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent },
      ['endpoint'],
    );
  }

  async unsubscribe(endpoint: string): Promise<void> {
    await this.subscriptionRepo.delete({ endpoint });
  }

  /** To every subscribed device. */
  async sendToAll(payload: PushPayload): Promise<PushResult> {
    return this.sendTo(await this.subscriptionRepo.find(), payload);
  }

  /** To one device (the Settings page's test button). */
  async sendToEndpoint(endpoint: string, payload: PushPayload): Promise<PushResult> {
    return this.sendTo(await this.subscriptionRepo.find({ where: { endpoint } }), payload);
  }

  private async sendTo(subscriptions: PushSubscriptionEntity[], payload: PushPayload): Promise<PushResult> {
    const result: PushResult = { sent: 0, removed: 0, failed: 0 };
    const body = JSON.stringify(payload);
    await Promise.all(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            body,
            { TTL: TTL_SECONDS, urgency: 'high' },
          );
          result.sent++;
          await this.subscriptionRepo.update(sub.id, { lastSuccessAt: new Date() });
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            // Gone: the app was removed or notifications were turned off on the device.
            result.removed++;
            await this.subscriptionRepo.delete(sub.id);
          } else {
            result.failed++;
            this.logger.warn(`Push to subscription ${sub.id} failed: ${status ?? ''} ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }),
    );
    if (subscriptions.length) this.logger.log(`Push "${payload.title}": ${result.sent} sent, ${result.removed} removed, ${result.failed} failed`);
    return result;
  }
}
