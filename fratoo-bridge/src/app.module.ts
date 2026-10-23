import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BlynkModule } from './blynk/blynk.module';
import { DatabaseModule } from './database/database.module';
import { ReadingsModule } from './readings/readings.module';
import { BatchesModule } from './batches/batches.module';
import { ReportsModule } from './reports/reports.module';
import { AuthModule } from './auth/auth.module';
import { PushModule } from './push/push.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BlynkModule,
    DatabaseModule,
    ReadingsModule,
    ReportsModule,
    BatchesModule,
    AuthModule,
    PushModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
