import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { ReadingEntity } from './entities/reading.entity';
import { BatchEntity } from './entities/batch.entity';
import { GravityReadingEntity } from './entities/gravity-reading.entity';
import { AppSettingEntity } from './entities/app-setting.entity';
import { BatchEventEntity } from './entities/batch-event.entity';
import { PushSubscriptionEntity } from './entities/push-subscription.entity';
import { BatchNotificationEntity } from './entities/batch-notification.entity';
import { DeviceEntity } from './entities/device.entity';

// Token for the shared TypeORM DataSource (see DATA_SOURCE usage in
// ReadingsService / BatchesService).
//
// Deliberately NOT using @nestjs/typeorm: as of the version that currently
// resolves against this project's @nestjs/* v11 line, it ships ESM-only
// (`"type": "module"`, no CJS build/export condition at all) and its
// compiled output uses `import.meta.url`, which crashes Jest's default
// CommonJS test runner the moment anything imports it — including
// transitively, through this module. Driving `typeorm` (itself still CJS)
// directly here avoids that fight entirely, at the cost of writing out
// DATA_SOURCE wiring by hand instead of using @InjectRepository. Revisit if
// @nestjs/typeorm ships a working CJS build again, or once this project
// moves to native ESM wholesale.
export const DATA_SOURCE = 'DATA_SOURCE';

// @Global() so every feature module can @Inject(DATA_SOURCE) without each
// one separately importing DatabaseModule.
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: DATA_SOURCE,
      inject: [ConfigService],
      useFactory: async (config: ConfigService): Promise<DataSource> => {
        const dataSource = new DataSource({
          type: 'postgres',
          host: config.get<string>('DB_HOST', 'localhost'),
          port: config.get<number>('DB_PORT', 5432),
          username: config.getOrThrow<string>('DB_USERNAME'),
          password: config.getOrThrow<string>('DB_PASSWORD'),
          database: config.getOrThrow<string>('DB_NAME'),
          entities: [
            ReadingEntity,
            BatchEntity,
            GravityReadingEntity,
            AppSettingEntity,
            BatchEventEntity,
            PushSubscriptionEntity,
            BatchNotificationEntity,
            DeviceEntity,
          ],
          // Schema changes go through db/init/*.sql, not TypeORM migrations
          // — see db/init/001_init_fratoo.sql and ProjectDocs/DEPLOYMENT.md.
          synchronize: false,
        });
        return dataSource.initialize();
      },
    },
  ],
  exports: [DATA_SOURCE],
})
export class DatabaseModule {}
