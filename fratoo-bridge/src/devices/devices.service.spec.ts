import { ConflictException, NotFoundException } from '@nestjs/common';
import { DevicesService } from './devices.service';
import { BatchEntity } from '../database/entities/batch.entity';
import { DeviceEntity } from '../database/entities/device.entity';
import { ReadingEntity } from '../database/entities/reading.entity';
import type { ReadingListener, ReadingsService } from '../readings/readings.service';

const TOKEN = '0123456789abcdef0123456789abcdef';

describe('DevicesService', () => {
  let service: DevicesService;
  let listener: ReadingListener;
  let execute: jest.Mock;
  const deviceRepo = {
    createQueryBuilder: jest.fn(),
    find: jest.fn(),
    findOneBy: jest.fn(),
    existsBy: jest.fn(),
    create: jest.fn((row: Partial<DeviceEntity>) => row),
    save: jest.fn((row: DeviceEntity) => Promise.resolve(row)),
    delete: jest.fn(),
  };
  const batchRepo = { find: jest.fn() };
  const readingRepo = { findOne: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    execute = jest.fn().mockResolvedValue({});
    const qb = { insert: () => qb, values: () => qb, orIgnore: () => qb, execute };
    deviceRepo.createQueryBuilder.mockReturnValue(qb);
    const dataSource = {
      getRepository: (entity: unknown) =>
        entity === DeviceEntity ? deviceRepo : entity === BatchEntity ? batchRepo : entity === ReadingEntity ? readingRepo : null,
    };
    const readings = {
      onInserted: (l: ReadingListener) => {
        listener = l;
        return () => undefined;
      },
    } as unknown as ReadingsService;
    service = new DevicesService(dataSource as never, readings);
    service.onModuleInit();
  });

  it('registers a new token from its first reading, and only queries once per token', async () => {
    listener({ deviceId: TOKEN } as ReadingEntity, false);
    await Promise.resolve();
    await service.register(TOKEN);
    await service.register(TOKEN);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('ignores readings without a token', async () => {
    await service.register('');
    expect(execute).not.toHaveBeenCalled();
  });

  it('tries again later if registering failed', async () => {
    execute.mockRejectedValueOnce(new Error('db down'));
    await service.register(TOKEN);
    await service.register(TOKEN);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('lists devices with last reading, active batch and newest batch start', async () => {
    deviceRepo.find.mockResolvedValue([
      { deviceId: TOKEN, name: 'Airlock 1', createdAt: new Date('2026-10-01T00:00:00Z') },
      { deviceId: 'spare', name: '', createdAt: new Date('2026-10-02T00:00:00Z') },
    ]);
    // Newest first, as the query orders them.
    batchRepo.find.mockResolvedValue([
      { id: 2, batchCode: 'IPA', deviceId: TOKEN, status: 'active', startedAt: new Date('2026-10-21T00:00:00Z') },
      { id: 1, batchCode: 'Pale', deviceId: TOKEN, status: 'completed', startedAt: new Date('2026-10-01T00:00:00Z') },
    ]);
    readingRepo.findOne.mockImplementation(({ where }: { where: { deviceId: string } }) =>
      Promise.resolve(where.deviceId === TOKEN ? { recordedAt: new Date('2026-10-24T06:54:00Z') } : null),
    );

    const [airlock, spare] = await service.list();
    expect(airlock).toMatchObject({
      name: 'Airlock 1',
      activeBatch: { id: 2, batchCode: 'IPA' },
      lastBatchStartedAt: new Date('2026-10-21T00:00:00Z'),
      lastReadingAt: new Date('2026-10-24T06:54:00Z'),
    });
    expect(spare).toMatchObject({ deviceId: 'spare', activeBatch: null, lastBatchStartedAt: null, lastReadingAt: null });
  });

  it('adds a device by hand (trimmed) and refuses a duplicate', async () => {
    deviceRepo.existsBy.mockResolvedValueOnce(false);
    await expect(service.create(`  ${TOKEN} `, ' Airlock 2 ')).resolves.toMatchObject({ deviceId: TOKEN, name: 'Airlock 2' });
    deviceRepo.existsBy.mockResolvedValueOnce(true);
    await expect(service.create(TOKEN, 'again')).rejects.toBeInstanceOf(ConflictException);
  });

  it('renames, and 404s an unknown device', async () => {
    deviceRepo.findOneBy.mockResolvedValueOnce({ deviceId: TOKEN, name: '' });
    await expect(service.rename(TOKEN, ' Big fermenter ')).resolves.toMatchObject({ name: 'Big fermenter' });
    deviceRepo.findOneBy.mockResolvedValueOnce(null);
    await expect(service.rename('nope', 'x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('forgets a removed device so its next reading adds it again', async () => {
    await service.register(TOKEN);
    deviceRepo.delete.mockResolvedValueOnce({ affected: 1 });
    await service.remove(TOKEN);
    await service.register(TOKEN);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('gives the name for the report, or null without one', async () => {
    deviceRepo.findOneBy.mockResolvedValueOnce({ deviceId: TOKEN, name: 'Airlock 1' });
    await expect(service.nameOf(TOKEN)).resolves.toBe('Airlock 1');
    deviceRepo.findOneBy.mockResolvedValueOnce({ deviceId: TOKEN, name: '' });
    await expect(service.nameOf(TOKEN)).resolves.toBeNull();
    await expect(service.nameOf('')).resolves.toBeNull();
  });
});
