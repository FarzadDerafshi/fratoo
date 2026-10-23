import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BatchesService } from '../batches/batches.service';
import { CreateGravityReadingDto, UpdateFermentationSettingsDto, UpdateGravityReadingDto } from './dto/fermentation.dto';
import { FermentationService } from './fermentation.service';

@UseGuards(JwtAuthGuard)
@Controller()
export class FermentationController {
  constructor(
    private readonly fermentation: FermentationService,
    private readonly batches: BatchesService,
  ) {}

  @Get('settings/fermentation')
  getSettings() {
    return this.fermentation.getSettings();
  }

  @Patch('settings/fermentation')
  updateSettings(@Body() dto: UpdateFermentationSettingsDto) {
    return this.fermentation.updateSettings(dto);
  }

  @Post('settings/fermentation/reset')
  resetSettings() {
    return this.fermentation.resetSettings();
  }

  /** Full model output: ABV, estimated gravity, which bubble volume was used and why, and every calibration point with its residual. */
  @Get('batches/:id/fermentation')
  async getEstimate(@Param('id', ParseIntPipe) id: number) {
    const batch = await this.batches.findOneOrThrow(id);
    const readings = await this.batches.getReadings(id);
    return this.fermentation.estimate(batch, readings);
  }

  /** ABV over time for the chart — see FermentationService.abvSeries(). */
  @Get('batches/:id/abv-series')
  async getAbvSeries(@Param('id', ParseIntPipe) id: number) {
    const batch = await this.batches.findOneOrThrow(id);
    const readings = await this.batches.getReadings(id);
    return this.fermentation.abvSeries(batch, readings);
  }

  @Get('batches/:id/gravity-readings')
  listGravity(@Param('id', ParseIntPipe) id: number) {
    return this.fermentation.listGravityReadings(id);
  }

  @Post('batches/:id/gravity-readings')
  addGravity(@Param('id', ParseIntPipe) id: number, @Body() dto: CreateGravityReadingDto) {
    return this.fermentation.addGravityReading(id, dto);
  }

  @Patch('batches/:id/gravity-readings/:readingId')
  updateGravity(
    @Param('id', ParseIntPipe) id: number,
    @Param('readingId', ParseIntPipe) readingId: number,
    @Body() dto: UpdateGravityReadingDto,
  ) {
    return this.fermentation.updateGravityReading(id, readingId, dto);
  }

  @Delete('batches/:id/gravity-readings/:readingId')
  @HttpCode(204)
  removeGravity(@Param('id', ParseIntPipe) id: number, @Param('readingId', ParseIntPipe) readingId: number) {
    return this.fermentation.removeGravityReading(id, readingId);
  }
}
