import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ReadingsService } from '../readings/readings.service';
import { ReportsService } from '../reports/reports.service';
import { FermentationService } from '../fermentation/fermentation.service';
import { VERSION_INFO } from '../app.service';
import { DevicesService } from '../devices/devices.service';
import { BatchesService } from './batches.service';
import { CreateBatchDto } from './dto/create-batch.dto';
import { UpdateBatchDto } from './dto/update-batch.dto';
import { CreateBatchEventDto, UpdateBatchEventDto } from './dto/batch-event.dto';

@UseGuards(JwtAuthGuard)
@Controller('batches')
export class BatchesController {
  constructor(
    private readonly batches: BatchesService,
    private readonly reports: ReportsService,
    private readonly fermentation: FermentationService,
    private readonly devices: DevicesService,
  ) {}

  @Get()
  findAll(
    @Query('status') status?: string,
    @Query('deviceId') deviceId?: string,
    @Query('page') page?: string,
    @Query('perPage') perPage?: string,
  ) {
    return this.batches.findAll({
      status,
      deviceId,
      page: page ? parseInt(page, 10) : undefined,
      perPage: perPage ? parseInt(perPage, 10) : undefined,
    });
  }

  @Post()
  create(@Body() dto: CreateBatchDto) {
    return this.batches.create(dto);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.batches.findOneOrThrow(id);
  }

  @Patch(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateBatchDto,
  ) {
    const batch = await this.batches.update(id, dto);
    // Volume, OG, sugar and the start date (window) all feed the calibration
    // fit — keep the cached fit in step with the batch (FermentationService).
    await this.fermentation.recalibrate(id);
    return this.batches.findOneOrThrow(batch.id);
  }

  @Post(':id/complete')
  complete(@Param('id', ParseIntPipe) id: number) {
    return this.batches.complete(id);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.batches.remove(id);
  }

  /** Reading count for the delete-confirmation dialog, without deleting anything. */
  @Get(':id/reading-count')
  async readingCount(@Param('id', ParseIntPipe) id: number) {
    return { count: await this.batches.countReadings(id) };
  }

  @Get(':id/readings')
  getReadings(@Param('id', ParseIntPipe) id: number) {
    return this.batches.getReadings(id);
  }

  @Get(':id/events')
  listEvents(@Param('id', ParseIntPipe) id: number) {
    return this.batches.listEvents(id);
  }

  @Post(':id/events')
  addEvent(@Param('id', ParseIntPipe) id: number, @Body() dto: CreateBatchEventDto) {
    return this.batches.addEvent(id, dto);
  }

  @Patch(':id/events/:eventId')
  updateEvent(
    @Param('id', ParseIntPipe) id: number,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Body() dto: UpdateBatchEventDto,
  ) {
    return this.batches.updateEvent(id, eventId, dto);
  }

  @Delete(':id/events/:eventId')
  @HttpCode(204)
  removeEvent(@Param('id', ParseIntPipe) id: number, @Param('eventId', ParseIntPipe) eventId: number) {
    return this.batches.removeEvent(id, eventId);
  }

  @Get(':id/stats')
  async getStats(@Param('id', ParseIntPipe) id: number) {
    const batch = await this.batches.findOneOrThrow(id);
    const readings = await this.batches.getReadings(id);
    const estimate = await this.fermentation.estimate(batch, readings);
    return {
      ...ReadingsService.computeStats(readings),
      // From the calibrated ABV model — GET :id/fermentation has the full detail.
      co2Liters: estimate.co2Liters,
      abv: estimate.abv,
      abvCapped: estimate.abvCapped,
      estimatedSg: estimate.estimatedSg,
      apparentAttenuation: estimate.apparentAttenuation,
      og: estimate.og,
      expectedAbv: estimate.expectedAbv,
      targetAbv: estimate.targetAbv,
      bubbleVolumeMl: estimate.bubbleVolumeMl,
      bubbleVolumeSource: estimate.bubbleVolumeSource,
    };
  }

  @Get(':id/report')
  async downloadReport(
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
  ) {
    const batch = await this.batches.findOneOrThrow(id);
    const readings = await this.batches.getReadings(id);
    if (!batch) throw new NotFoundException();

    // Same sources as the dashboard's batch page (stats, fermentation, gravity-readings, abv-series).
    const html = this.reports.generateReportHtml({
      batch,
      readings,
      stats: ReadingsService.computeStats(readings),
      estimate: await this.fermentation.estimate(batch, readings),
      gravity: await this.fermentation.listGravityReadings(id),
      events: await this.batches.listEvents(id),
      abvSeries: await this.fermentation.abvSeries(batch, readings),
      abvAt: await this.fermentation.abvTimeline(batch, readings),
      version: `v${VERSION_INFO.version} (${VERSION_INFO.commit})`,
      deviceName: await this.devices.nameOf(batch.deviceId),
    });
    const filename = this.reports.reportFilename(batch);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(html);
  }
}
