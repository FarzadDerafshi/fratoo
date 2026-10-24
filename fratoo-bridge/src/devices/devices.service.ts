import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { DataSource, In, Repository } from 'typeorm';
import { DATA_SOURCE } from '../database/database.module';
import { BatchEntity } from '../database/entities/batch.entity';
import { DeviceEntity } from '../database/entities/device.entity';
import { ReadingEntity } from '../database/entities/reading.entity';
import { ReadingsService } from '../readings/readings.service';

export interface DeviceSummary {
  deviceId: string;
  name: string;
  createdAt: Date;
  /** Newest reading from this device, any pin. */
  lastReadingAt: Date | null;
  /** The device's active batch, if any (normally at most one). */
  activeBatch: { id: number; batchCode: string } | null;
  /** Start of the newest batch on this device — the new-batch form preselects the most recently used device. */
  lastBatchStartedAt: Date | null;
}

/**
 * The known airlocks: a name for each device token, so batches pick their
 * device from a list. A device is added the first time its token sends a
 * reading (or by hand); batches and readings keep referring to the token
 * itself, so renaming or removing a device never touches them.
 */
@Injectable()
export class DevicesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DevicesService.name);
  private readonly repo: Repository<DeviceEntity>;
  /** Tokens already known to be in the table, so a reading costs no query once seen. */
  private readonly known = new Set<string>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly readings: ReadingsService,
  ) {
    this.repo = this.dataSource.getRepository(DeviceEntity);
  }

  onModuleInit(): void {
    this.unsubscribe = this.readings.onInserted((reading) => void this.register(reading.deviceId));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  /** Adds a token the first time it's seen. Never renames or re-adds a known one within this run. */
  async register(deviceId: string): Promise<void> {
    if (!deviceId || this.known.has(deviceId)) return;
    try {
      await this.repo
        .createQueryBuilder()
        .insert()
        .values({ deviceId })
        .orIgnore()
        .execute();
      this.known.add(deviceId);
    } catch (err) {
      this.logger.error(`Failed to register device ${deviceId.slice(0, 8)}…: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async list(): Promise<DeviceSummary[]> {
    const devices = await this.repo.find({ order: { createdAt: 'ASC' } });
    if (!devices.length) return [];
    const ids = devices.map((d) => d.deviceId);

    const batches = await this.dataSource.getRepository(BatchEntity).find({
      where: { deviceId: In(ids) },
      select: { id: true, batchCode: true, deviceId: true, status: true, startedAt: true },
      order: { startedAt: 'DESC' },
    });
    const readingRepo = this.dataSource.getRepository(ReadingEntity);

    return Promise.all(
      devices.map(async (d) => {
        const mine = batches.filter((b) => b.deviceId === d.deviceId);
        const active = mine.find((b) => b.status === 'active');
        // One indexed lookup per device (idx_device_time) — there are only ever a handful.
        const last = await readingRepo.findOne({
          where: { deviceId: d.deviceId },
          select: { id: true, recordedAt: true },
          order: { recordedAt: 'DESC' },
        });
        return {
          deviceId: d.deviceId,
          name: d.name,
          createdAt: d.createdAt,
          lastReadingAt: last?.recordedAt ?? null,
          activeBatch: active ? { id: active.id, batchCode: active.batchCode } : null,
          lastBatchStartedAt: mine[0]?.startedAt ?? null,
        };
      }),
    );
  }

  async create(deviceId: string, name: string): Promise<DeviceEntity> {
    const id = deviceId.trim();
    if (await this.repo.existsBy({ deviceId: id })) throw new ConflictException('That airlock is already in the list.');
    const saved = await this.repo.save(this.repo.create({ deviceId: id, name: name.trim() }));
    this.known.add(id);
    return saved;
  }

  async rename(deviceId: string, name: string): Promise<DeviceEntity> {
    const device = await this.repo.findOneBy({ deviceId });
    if (!device) throw new NotFoundException('Airlock not found.');
    device.name = name.trim();
    return this.repo.save(device);
  }

  /** Removes the name only; readings and batches keep the token. A device that's still sending comes back with its next reading. */
  async remove(deviceId: string): Promise<void> {
    const result = await this.repo.delete({ deviceId });
    if (!result.affected) throw new NotFoundException('Airlock not found.');
    this.known.delete(deviceId);
  }

  /** The device's name, or null when it has none (or isn't in the list). */
  async nameOf(deviceId: string): Promise<string | null> {
    if (!deviceId) return null;
    const device = await this.repo.findOneBy({ deviceId });
    return device?.name || null;
  }
}
