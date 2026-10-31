import { IsNull, Not } from 'typeorm';
import { DATA_SOURCE } from '../database/database.module';
import { BatchesService } from '../batches/batches.service';
import { FermentationService } from './fermentation.service';
import { Test } from '@nestjs/testing';

// Calibration sharing: a batch with sharing turned off keeps its fit to
// itself, so it must never reach the learned volume other batches start from.
describe('FermentationService.learnedBubbleVolume', () => {
  it('only learns from other batches that share their calibration', async () => {
    const find = jest.fn().mockResolvedValue([
      { id: 2, calibratedBubbleVolumeMl: 0.28, calibrationPoints: 1 },
      { id: 3, calibratedBubbleVolumeMl: 0.34, calibrationPoints: 3 },
    ]);
    const module = await Test.createTestingModule({
      providers: [
        FermentationService,
        {
          provide: DATA_SOURCE,
          useValue: { getRepository: jest.fn().mockReturnValue({ find }) },
        },
        { provide: BatchesService, useValue: {} },
      ],
    }).compile();

    const learned = await module
      .get(FermentationService)
      .learnedBubbleVolume(1);

    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: Not(1),
          calibratedBubbleVolumeMl: Not(IsNull()),
          shareCalibration: true,
        },
      }),
    );
    expect(learned).toBeCloseTo((0.28 * 1 + 0.34 * 3) / 4);
  });
});

// Airlock segments: rates before the change are rescaled into bubbles of the
// current size; counters (the ABV model's input) are left alone.
describe('FermentationService.withComparableRates', () => {
  const change = new Date('2026-10-24T07:16:00Z');
  const before = new Date('2026-10-23T21:00:00Z');
  const after = new Date('2026-10-25T21:00:00Z');
  const readings = [
    { pin: 'V100', value: 99629, bubbleRate: 64, recordedAt: before },
    { pin: 'V101', value: 700, bubbleRate: 0, recordedAt: before },
    { pin: 'V100', value: 539120, bubbleRate: 115, recordedAt: after },
  ];
  const estimate = {
    airlockSegments: [
      {
        startsAt: null,
        bubbleVolumeMl: 2.1,
        source: 'batch-calibration',
        usablePoints: 1,
      },
      {
        startsAt: change,
        bubbleVolumeMl: 0.14,
        source: 'batch-calibration',
        usablePoints: 1,
      },
    ],
  };

  async function serviceWithEvents(
    events: { kind: string; occurredAt: Date }[],
  ) {
    const module = await Test.createTestingModule({
      providers: [
        FermentationService,
        {
          provide: DATA_SOURCE,
          useValue: { getRepository: jest.fn().mockReturnValue({}) },
        },
        {
          provide: BatchesService,
          useValue: { listEvents: jest.fn().mockResolvedValue(events) },
        },
      ],
    }).compile();
    return module.get(FermentationService);
  }

  it('scales earlier segments to the current bubble size', async () => {
    const service = await serviceWithEvents([
      { kind: 'dry_hop', occurredAt: before },
      { kind: 'airlock', occurredAt: change },
    ]);
    const out = await service.withComparableRates(
      { id: 1 } as never,
      readings as never,
      estimate as never,
    );
    expect(out.map((r) => r.bubbleRate)).toEqual([
      expect.closeTo(64 * (2.1 / 0.14), 9),
      0,
      115,
    ]);
    expect(out.map((r) => r.value)).toEqual(readings.map((r) => r.value));
  });

  it('leaves a batch without airlock changes untouched', async () => {
    const service = await serviceWithEvents([
      { kind: 'dry_hop', occurredAt: before },
    ]);
    const out = await service.withComparableRates(
      { id: 1 } as never,
      readings as never,
      estimate as never,
    );
    expect(out).toBe(readings);
  });
});
