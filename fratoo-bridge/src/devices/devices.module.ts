import { Module } from '@nestjs/common';
import { ReadingsModule } from '../readings/readings.module';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';

// DATA_SOURCE comes from the @Global() DatabaseModule. Reads batches through
// the repository directly rather than BatchesService, so BatchesModule can
// import this module (device name on the report) without a cycle.
@Module({
  imports: [ReadingsModule],
  controllers: [DevicesController],
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
