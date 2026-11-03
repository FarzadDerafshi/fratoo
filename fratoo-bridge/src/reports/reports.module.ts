import { Module } from '@nestjs/common';
import { PdfService } from './pdf.service';
import { ReportsService } from './reports.service';

@Module({
  providers: [ReportsService, PdfService],
  exports: [ReportsService, PdfService],
})
export class ReportsModule {}
