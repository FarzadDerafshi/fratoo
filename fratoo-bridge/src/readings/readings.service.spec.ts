import { Test, TestingModule } from '@nestjs/testing';
import { ReadingsService, SPARKLINE_BUCKETS } from './readings.service';
import { ReadingEntity } from '../database/entities/reading.entity';
import { BlynkService } from '../blynk/blynk.service';
import { DATA_SOURCE } from '../database/database.module';

// Verifies the V100 delta engine against the exact rules ported from
// Fratoo_DB::insert_reading() in the WordPress plugin (see
// ProjectDocs/ARCHITECTURE.md) — this was flagged as the highest-risk piece
// of ported logic (ProjectDocs/DECISIONS.md), so it gets a real test rather
// than just a manual read-through.
describe('ReadingsService', () => {
  let service: ReadingsService;
  let findOneMock: jest.Mock;
  let createMock: jest.Mock;
  let saveMock: jest.Mock;

  beforeEach(async () => {
    findOneMock = jest.fn();
    createMock = jest.fn((row: Partial<ReadingEntity>) => row as ReadingEntity);
    saveMock = jest.fn((row: ReadingEntity) => Promise.resolve(row));

    const mockRepo = { findOne: findOneMock, create: createMock, save: saveMock };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReadingsService,
        {
          provide: DATA_SOURCE,
          useValue: { getRepository: jest.fn().mockReturnValue(mockRepo) },
        },
        { provide: BlynkService, useValue: { on: jest.fn(), off: jest.fn() } },
      ],
    }).compile();

    service = module.get(ReadingsService);
  });

  it('stores bubble_rate = 0 for non-V100 pins regardless of prior rows', async () => {
    const result = await service.insertReading({
      deviceId: 'dev1',
      pin: 'V101',
      value: '24.5',
      receivedAt: new Date('2026-07-10T21:00:00Z'),
    });

    expect(findOneMock).not.toHaveBeenCalled();
    expect(result.bubbleRate).toBe(0);
  });

  it('stores bubble_rate = 0 for the first-ever V100 reading (no prior row)', async () => {
    findOneMock.mockResolvedValue(null);

    const result = await service.insertReading({
      deviceId: 'dev1',
      pin: 'V100',
      value: '100',
      receivedAt: new Date('2026-07-10T21:00:00Z'),
    });

    expect(result.bubbleRate).toBe(0);
  });

  it('computes bubble_rate = deltaBubbles / deltaMinutes for a normal increase', async () => {
    findOneMock.mockResolvedValue({
      value: 100,
      recordedAt: new Date('2026-07-10T21:00:00Z'),
    });

    // +120 bubbles over 5 minutes = 24 bpm
    const result = await service.insertReading({
      deviceId: 'dev1',
      pin: 'V100',
      value: '220',
      receivedAt: new Date('2026-07-10T21:05:00Z'),
    });

    expect(result.bubbleRate).toBeCloseTo(24, 5);
  });

  it('pins bubble_rate to 0 on a negative delta (hardware reboot resets the counter)', async () => {
    findOneMock.mockResolvedValue({
      value: 5000,
      recordedAt: new Date('2026-07-10T21:00:00Z'),
    });

    const result = await service.insertReading({
      deviceId: 'dev1',
      pin: 'V100',
      value: '3', // counter reset after reboot
      receivedAt: new Date('2026-07-10T21:05:00Z'),
    });

    expect(result.bubbleRate).toBe(0);
  });

  it('pins bubble_rate to 0 when deltaMinutes is 0 (same-timestamp duplicate)', async () => {
    const ts = new Date('2026-07-10T21:00:00Z');
    findOneMock.mockResolvedValue({ value: 100, recordedAt: ts });

    const result = await service.insertReading({
      deviceId: 'dev1',
      pin: 'V100',
      value: '110',
      receivedAt: ts,
    });

    expect(result.bubbleRate).toBe(0);
  });
});

describe('ReadingsService.computeStats', () => {
  function reading(pin: string, value: number, bubbleRate: number, recordedAt: string): ReadingEntity {
    return { id: 1, deviceId: 'dev1', pin, value, bubbleRate, recordedAt: new Date(recordedAt) } as ReadingEntity;
  }

  it('sums only positive V100 deltas into totalBubbles, ignoring a reboot dip', () => {
    const readings = [
      reading('V100', 100, 0, '2026-07-10T20:00:00Z'),
      reading('V100', 220, 24, '2026-07-10T20:05:00Z'), // +120
      reading('V100', 5, 0, '2026-07-10T20:10:00Z'), // reboot — negative delta, ignored
      reading('V100', 55, 10, '2026-07-10T20:15:00Z'), // +50
    ];

    const stats = ReadingsService.computeStats(readings);
    expect(stats.totalBubbles).toBe(170);
    expect(stats.peakRate).toBe(24);
  });

  it('averages PCB-corrected temperature across V101 rows', () => {
    const readings = [reading('V101', 30, 0, '2026-07-10T20:00:00Z'), reading('V101', 20, 0, '2026-07-10T20:05:00Z')];

    const stats = ReadingsService.computeStats(readings);
    // correctTemperature(30) = 0.9133*30 - 1.145 = 26.254; (20) = 17.121; avg = 21.6875
    expect(stats.avgTemp).toBeCloseTo(21.6875, 4);
  });

  it('reports the latest rate, temperature and reading time', () => {
    const readings = [
      reading('V100', 100, 30, '2026-07-10T20:00:00Z'),
      reading('V101', 30, 0, '2026-07-10T20:00:30Z'),
      reading('V100', 160, 12, '2026-07-10T20:05:00Z'),
      reading('V101', 20, 0, '2026-07-10T20:05:30Z'),
    ];

    const stats = ReadingsService.computeStats(readings);
    expect(stats.currentRate).toBe(12);
    expect(stats.currentTemp).toBeCloseTo(17.121, 3);
    expect(stats.lastReadingAt?.toISOString()).toBe('2026-07-10T20:05:30.000Z');
  });

  it('averages bubble rate into at most SPARKLINE_BUCKETS slices', () => {
    const readings = Array.from({ length: 500 }, (_, i) =>
      reading('V100', i * 10, i % 2 ? 20 : 10, new Date(Date.UTC(2026, 6, 10) + i * 300_000).toISOString()),
    );

    const { sparkline } = ReadingsService.computeStats(readings);
    expect(sparkline.length).toBe(SPARKLINE_BUCKETS);
    for (const p of sparkline) expect(p.rate).toBeCloseTo(15, 0);
  });

  it('has no current values or sparkline without readings', () => {
    const stats = ReadingsService.computeStats([]);
    expect(stats.currentRate).toBeNull();
    expect(stats.lastReadingAt).toBeNull();
    expect(stats.sparkline).toEqual([]);
  });
});
