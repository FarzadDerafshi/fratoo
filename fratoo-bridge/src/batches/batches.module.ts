import { Module } from '@nestjs/common';
import { ReadingsModule } from '../readings/readings.module';
import { ReportsModule } from '../reports/reports.module';
import { BatchesController } from './batches.controller';
import { BatchesService } from './batches.service';
import { FermentationController } from '../fermentation/fermentation.controller';
import { FermentationService } from '../fermentation/fermentation.service';

// DATA_SOURCE comes from the @Global() DatabaseModule — no explicit import
// needed here (see src/database/database.module.ts).
//
// FermentationService/Controller live in src/fermentation but are
// registered here rather than in their own module: they need
// BatchesService (batch windows), and BatchesController needs them back
// (stats, recalibrate-on-edit, report ABV) — one module avoids a circular
// module import.
@Module({
  imports: [ReadingsModule, ReportsModule],
  controllers: [BatchesController, FermentationController],
  providers: [BatchesService, FermentationService],
  exports: [BatchesService, FermentationService],
})
export class BatchesModule {}
