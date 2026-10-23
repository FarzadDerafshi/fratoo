import { Module } from '@nestjs/common';
import { BlynkService } from './blynk.service';

@Module({
  providers: [BlynkService],
  exports:   [BlynkService],
})
export class BlynkModule {}
