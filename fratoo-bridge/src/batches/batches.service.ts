import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Between, DataSource, MoreThan, Not, Repository } from 'typeorm';
import { DATA_SOURCE } from '../database/database.module';
import { BatchEntity } from '../database/entities/batch.entity';
import { BatchEventEntity } from '../database/entities/batch-event.entity';
import { ReadingEntity } from '../database/entities/reading.entity';
import { ReadingsService } from '../readings/readings.service';
import { CreateBatchDto } from './dto/create-batch.dto';
import { UpdateBatchDto } from './dto/update-batch.dto';
import { CreateBatchEventDto, UpdateBatchEventDto } from './dto/batch-event.dto';

export interface BatchWindow {
  deviceId: string;
  from: Date;
  to: Date;
}

export interface ListBatchesQuery {
  status?: string;
  deviceId?: string;
  perPage?: number;
  page?: number;
}

/**
 * Batches have no FK to readings — they're linked only by device_id + a time
 * window (started_at .. ended_at ?? now()). resolveWindow() is the single
 * shared implementation of that resolution, ported from
 * Fratoo_DB::resolve_batch_window() in the WordPress plugin — every method
 * here that needs "the readings for this batch" goes through it, so reads,
 * counts, reports, and deletes can never disagree about what a batch means.
 * See ProjectDocs/DECISIONS.md.
 */
@Injectable()
export class BatchesService {
  private readonly repo: Repository<BatchEntity>;
  private readonly eventRepo: Repository<BatchEventEntity>;

  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly readingsService: ReadingsService,
  ) {
    this.repo = this.dataSource.getRepository(BatchEntity);
    this.eventRepo = this.dataSource.getRepository(BatchEventEntity);
  }

  async create(dto: CreateBatchDto): Promise<BatchEntity> {
    if ((dto.ogValue === undefined) !== (dto.ogUnit === undefined)) {
      throw new BadRequestException('ogValue and ogUnit must be given together');
    }
    const now = new Date();
    return this.repo.save(
      this.repo.create({
        batchCode: dto.batchCode,
        deviceId: dto.deviceId ?? '',
        brewType: dto.brewType ?? 'beer',
        status: 'active',
        volumeLiters: dto.volumeLiters ?? null,
        addedSugarG: dto.addedSugarG ?? null,
        notes: dto.notes ?? null,
        ogValue: dto.ogValue ?? null,
        ogUnit: dto.ogUnit ?? null,
        ogIncludesSugar: dto.ogIncludesSugar ?? true,
        targetAbv: dto.targetAbv ?? null,
        bubbleVolumeMl: dto.bubbleVolumeMl ?? null,
        yeastStrain: dto.yeastStrain?.trim() || null,
        yeastAttenuation: dto.yeastAttenuation ?? null,
        pitchedAt: dto.pitchedAt ? new Date(dto.pitchedAt) : null,
        pitchTempC: dto.pitchTempC ?? null,
        hops: dto.hops?.trim() || null,
        primingSugarG: null,
        bottledVolumeL: null,
        bottleCount: null,
        tastingNotes: null,
        startedAt: now,
        endedAt: null,
        createdAt: now,
      }),
    );
  }

  findAll(query: ListBatchesQuery): Promise<BatchEntity[]> {
    const where: Partial<Record<'status' | 'deviceId', string>> = {};
    if (query.status) where.status = query.status;
    if (query.deviceId) where.deviceId = query.deviceId;

    const perPage = Math.min(query.perPage ?? 50, 200);
    const page = Math.max(query.page ?? 1, 1);

    return this.repo.find({
      where,
      order: { startedAt: 'DESC' },
      take: perPage,
      skip: (page - 1) * perPage,
    });
  }

  findOne(id: number): Promise<BatchEntity | null> {
    return this.repo.findOne({ where: { id } });
  }

  async findOneOrThrow(id: number): Promise<BatchEntity> {
    const batch = await this.findOne(id);
    if (!batch) throw new NotFoundException(`Batch ${id} not found`);
    return batch;
  }

  async update(id: number, dto: UpdateBatchDto): Promise<BatchEntity> {
    const batch = await this.findOneOrThrow(id);

    if (dto.batchCode !== undefined) batch.batchCode = dto.batchCode;
    if (dto.deviceId !== undefined) batch.deviceId = dto.deviceId;
    if (dto.brewType !== undefined) batch.brewType = dto.brewType;
    if (dto.startedAt !== undefined) batch.startedAt = new Date(dto.startedAt);
    if (dto.status !== undefined) batch.status = dto.status;
    if (dto.endedAt !== undefined) batch.endedAt = dto.endedAt === null ? null : new Date(dto.endedAt);
    if (dto.volumeLiters !== undefined) batch.volumeLiters = dto.volumeLiters;
    if (dto.addedSugarG !== undefined) batch.addedSugarG = dto.addedSugarG;
    if (dto.notes !== undefined) batch.notes = dto.notes;
    if (dto.ogValue !== undefined) batch.ogValue = dto.ogValue;
    if (dto.ogUnit !== undefined) batch.ogUnit = dto.ogUnit;
    if (dto.ogIncludesSugar !== undefined) batch.ogIncludesSugar = dto.ogIncludesSugar;
    if (dto.targetAbv !== undefined) batch.targetAbv = dto.targetAbv;
    if (dto.bubbleVolumeMl !== undefined) batch.bubbleVolumeMl = dto.bubbleVolumeMl;
    if (dto.yeastStrain !== undefined) batch.yeastStrain = dto.yeastStrain?.trim() || null;
    if (dto.yeastAttenuation !== undefined) batch.yeastAttenuation = dto.yeastAttenuation;
    if (dto.pitchedAt !== undefined) batch.pitchedAt = dto.pitchedAt === null ? null : new Date(dto.pitchedAt);
    if (dto.pitchTempC !== undefined) batch.pitchTempC = dto.pitchTempC;
    if (dto.alertTempMinC !== undefined) batch.alertTempMinC = dto.alertTempMinC;
    if (dto.alertTempMaxC !== undefined) batch.alertTempMaxC = dto.alertTempMaxC;
    if (dto.hops !== undefined) batch.hops = dto.hops?.trim() || null;
    if (dto.primingSugarG !== undefined) batch.primingSugarG = dto.primingSugarG;
    if (dto.bottledVolumeL !== undefined) batch.bottledVolumeL = dto.bottledVolumeL;
    if (dto.bottleCount !== undefined) batch.bottleCount = dto.bottleCount;
    if (dto.tastingNotes !== undefined) batch.tastingNotes = dto.tastingNotes?.trim() || null;

    // An OG value without a unit (or vice versa) can't be interpreted.
    if ((batch.ogValue === null) !== (batch.ogUnit === null)) {
      throw new BadRequestException('ogValue and ogUnit must be set (or cleared) together');
    }

    return this.repo.save(batch);
  }

  /** Sets status + ended_at in one call — the dashboard's "Complete Fermentation" action. */
  complete(id: number): Promise<BatchEntity> {
    return this.update(id, { status: 'completed', endedAt: new Date().toISOString() });
  }

  /**
   * Resolves a batch's telemetry window, clamped so it never reaches into a
   * subsequent batch on the same device — the "next batch guard". Without
   * this, deleting (or reporting on) an open-ended/active batch could
   * otherwise claim every reading recorded after it started, including a
   * later batch's. `batchRepo` is injectable so this same logic runs both
   * standalone and inside remove()'s transaction.
   */
  private async resolveWindowWith(batchRepo: Repository<BatchEntity>, batch: BatchEntity): Promise<BatchWindow | null> {
    if (!batch.deviceId) return null;

    const from = batch.startedAt;
    let to = batch.endedAt ?? new Date();

    // `id: Not(batch.id)` explicitly excludes this same batch — relying on
    // `startedAt: MoreThan(from)` alone to do that is NOT safe: Postgres
    // timestamps carry microsecond precision but a JS `Date` only carries
    // milliseconds, so a value read back as `batch.startedAt` and then
    // compared against the database's full-precision copy of itself can
    // come out as "greater than", matching the batch against itself and
    // clamping its own window down to nothing. Caught via smoke-testing
    // with a raw-SQL-backdated started_at (microsecond precision); the
    // WordPress-era PHP had this same latent gap, just never triggered by
    // MySQL's second-precision DATETIME. See ProjectDocs/DECISIONS.md.
    const nextBatch = await batchRepo.findOne({
      where: { deviceId: batch.deviceId, id: Not(batch.id), startedAt: MoreThan(from) },
      order: { startedAt: 'ASC' },
    });

    if (nextBatch && nextBatch.startedAt < to) {
      to = nextBatch.startedAt;
    }

    return { deviceId: batch.deviceId, from, to };
  }

  resolveWindow(batch: BatchEntity): Promise<BatchWindow | null> {
    return this.resolveWindowWith(this.repo, batch);
  }

  async countReadings(id: number): Promise<number> {
    const batch = await this.findOneOrThrow(id);
    const window = await this.resolveWindow(batch);
    if (!window) return 0;
    return this.readingsService.countByDeviceAndWindow(window.deviceId, window.from, window.to);
  }

  async getReadings(id: number): Promise<ReadingEntity[]> {
    const batch = await this.findOneOrThrow(id);
    const window = await this.resolveWindow(batch);
    if (!window) return [];
    return this.readingsService.findByDeviceAndWindow(window.deviceId, window.from, window.to);
  }

  /**
   * Permanently deletes a batch and every reading inside its resolved
   * window. Runs inside a transaction with a pessimistic lock on the batch
   * row (so a concurrent "Complete Fermentation" can't race the window
   * computed here) — ported from Fratoo_DB::delete_batch().
   */
  async remove(id: number): Promise<{ deletedReadings: number }> {
    return this.dataSource.transaction(async (manager) => {
      const batchRepo = manager.getRepository(BatchEntity);
      const readingRepo = manager.getRepository(ReadingEntity);

      const batch = await batchRepo.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!batch) throw new NotFoundException(`Batch ${id} not found`);

      const window = await this.resolveWindowWith(batchRepo, batch);
      let deletedReadings = 0;

      if (window) {
        const result = await readingRepo.delete({
          deviceId: window.deviceId,
          recordedAt: Between(window.from, window.to),
        });
        deletedReadings = result.affected ?? 0;
      }

      await batchRepo.delete({ id: batch.id });

      return { deletedReadings };
    });
  }

  // --- Events (dry hop, bottling, disturbances …) ---------------------------
  // Annotations only — they never feed the ABV model, so no recalibration.

  async listEvents(batchId: number): Promise<BatchEventEntity[]> {
    await this.findOneOrThrow(batchId);
    return this.eventRepo.find({ where: { batchId }, order: { occurredAt: 'ASC' } });
  }

  async addEvent(batchId: number, dto: CreateBatchEventDto): Promise<BatchEventEntity> {
    await this.findOneOrThrow(batchId);
    return this.eventRepo.save(
      this.eventRepo.create({
        batchId,
        occurredAt: new Date(dto.occurredAt),
        kind: dto.kind,
        notes: dto.notes?.trim() || null,
      }),
    );
  }

  async updateEvent(batchId: number, id: number, dto: UpdateBatchEventDto): Promise<BatchEventEntity> {
    const event = await this.findEventOrThrow(batchId, id);
    if (dto.occurredAt !== undefined) event.occurredAt = new Date(dto.occurredAt);
    if (dto.kind !== undefined) event.kind = dto.kind;
    if (dto.notes !== undefined) event.notes = dto.notes?.trim() || null;
    return this.eventRepo.save(event);
  }

  async removeEvent(batchId: number, id: number): Promise<void> {
    const event = await this.findEventOrThrow(batchId, id);
    await this.eventRepo.delete({ id: event.id });
  }

  private async findEventOrThrow(batchId: number, id: number): Promise<BatchEventEntity> {
    const event = await this.eventRepo.findOne({ where: { id, batchId } });
    if (!event) throw new NotFoundException(`Event ${id} not found on batch ${batchId}`);
    return event;
  }
}
