import { Module } from '@nestjs/common';
import { BlynkModule } from '../blynk/blynk.module';
import { ReadingsService } from './readings.service';

// DATA_SOURCE comes from the @Global() DatabaseModule — no explicit import
// needed here (see src/database/database.module.ts).
@Module({
  imports: [BlynkModule],
  providers: [ReadingsService],
  exports: [ReadingsService],
})
export class ReadingsModule {}
