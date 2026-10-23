import { BadRequestException, Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AlertsService } from './alerts.service';
import { UpdateNotificationSettingsDto } from './push.dto';

@UseGuards(JwtAuthGuard)
@Controller('settings/notifications')
export class NotificationSettingsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  get() {
    return this.alerts.getSettings();
  }

  @Patch()
  async update(@Body() dto: UpdateNotificationSettingsDto) {
    // The validated DTO carries every declared field, the unsent ones as undefined.
    const changes = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined));
    const merged = { ...(await this.alerts.getSettings()), ...changes };
    if (merged.tempMinC >= merged.tempMaxC) throw new BadRequestException('The low temperature limit must be below the high one.');
    return this.alerts.updateSettings(changes);
  }
}
