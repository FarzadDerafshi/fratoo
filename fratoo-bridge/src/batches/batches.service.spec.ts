import { Test, TestingModule } from '@nestjs/testing';
import { BatchesService } from './batches.service';
import { ReadingsService } from '../readings/readings.service';
import { DATA_SOURCE } from '../database/database.module';
import { BatchEntity } from '../database/entities/batch.entity';

// Regression test for a bug caught via smoke-testing (see
// ProjectDocs/DECISIONS.md): resolveWindow()'s next-batch guard must
// exclude the batch's own row explicitly (`id: Not(batch.id)`) rather than
// relying on `startedAt: MoreThan(from)` alone to do it — a stored
// timestamp's sub-millisecond precision can make a batch compare as
// "later than" the truncated JS `Date` copy of its own startedAt, matching
// itself as its own "next batch" and clamping its window down to nothing.
describe('BatchesService.resolveWindow', () => {
  let service: BatchesService;
  let findOneMock: jest.Mock;

  function makeBatch(overrides: Partial<BatchEntity> = {}): BatchEntity {
    return {
      id: 1,
      batchCode: 'TEST',
      deviceId: 'dev1',
      brewType: 'beer',
      status: 'active',
      volumeLiters: null,
      addedSugarG: null,
      notes: null,
      ogValue: null,
      ogUnit: null,
      ogIncludesSugar: true,
      targetAbv: null,
      bubbleVolumeMl: null,
      calibratedBubbleVolumeMl: null,
      calibrationPoints: 0,
      shareCalibration: true,
      yeastStrain: null,
      yeastAttenuation: null,
      pitchedAt: null,
      pitchTempC: null,
      hops: null,
      primingSugarG: null,
      bottledVolumeL: null,
      bottleCount: null,
      tastingNotes: null,
      alertTempMinC: null,
      alertTempMaxC: null,
      startedAt: new Date('2026-07-10T17:00:44.399Z'),
      endedAt: null,
      createdAt: new Date('2026-07-10T17:00:44.399Z'),
      ...overrides,
    };
  }

  beforeEach(async () => {
    findOneMock = jest.fn();
    const mockRepo = { findOne: findOneMock };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BatchesService,
        { provide: DATA_SOURCE, useValue: { getRepository: jest.fn().mockReturnValue(mockRepo), transaction: jest.fn() } },
        { provide: ReadingsService, useValue: {} },
      ],
    }).compile();

    service = module.get(BatchesService);
  });

  it('never matches a batch against itself as its own "next batch"', async () => {
    const batch = makeBatch();
    // The mock repo's findOne is a stand-in for "the next-batch query" —
    // simulate the exact failure mode: a naive query (no `id: Not(...)`)
    // would find this same row again due to timestamp precision drift.
    // With the fix in place, the service passes `id: Not(batch.id)` in the
    // where clause, so a correctly-filtering repo would return null here.
    findOneMock.mockImplementation(({ where }) => {
      // Simulate a real DB honoring the `id: Not(batch.id)` filter.
      if (where.id?.type === 'not' && where.id.value === batch.id) return Promise.resolve(null);
      return Promise.resolve(batch); // naive query would wrongly return itself
    });

    const window = await service.resolveWindow(batch);

    expect(window).not.toBeNull();
    expect(window!.to.getTime()).toBeGreaterThan(window!.from.getTime());
    // Confirms the query actually asked to exclude this batch's own id.
    expect(findOneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: expect.objectContaining({ value: batch.id }) }),
      }),
    );
  });

  it('clamps the window to a genuinely later batch on the same device', async () => {
    const batch = makeBatch({ id: 1, startedAt: new Date('2026-07-10T17:00:00.000Z') });
    const laterBatch = makeBatch({ id: 2, startedAt: new Date('2026-07-10T20:00:00.000Z') });
    findOneMock.mockResolvedValue(laterBatch);

    const window = await service.resolveWindow(batch);

    expect(window!.to).toEqual(laterBatch.startedAt);
  });

  it('returns null for a batch with no device_id', async () => {
    const window = await service.resolveWindow(makeBatch({ deviceId: '' }));
    expect(window).toBeNull();
  });
});
