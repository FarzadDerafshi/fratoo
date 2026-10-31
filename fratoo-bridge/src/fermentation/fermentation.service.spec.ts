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
