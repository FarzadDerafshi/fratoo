import { Module } from '@nestjs/common';
import { BatchesModule } from '../batches/batches.module';
import { ReadingsModule } from '../readings/readings.module';
import { AlertsService } from './alerts.service';
import { NotificationSettingsController } from './notification-settings.controller';
import { PushController } from './push.controller';
import { PushService } from './push.service';

// Web Push notifications and the alerts that use them — see ProjectDocs/DECISIONS.md
// "Push notifications" and "Push alerts".
@Module({
  imports: [ReadingsModule, BatchesModule],
  controllers: [PushController, NotificationSettingsController],
  providers: [PushService, AlertsService],
})
export class PushModule {}
