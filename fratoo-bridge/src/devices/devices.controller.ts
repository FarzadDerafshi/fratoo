import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { IsString, Matches, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DevicesService } from './devices.service';

export class CreateDeviceDto {
  // Blynk tokens are 32 letters and digits; anything token-like up to the column size is accepted.
  @Matches(/^\s*[A-Za-z0-9_-]{1,64}\s*$/, { message: 'Airlock token: letters, digits, - and _ only, up to 64 characters.' })
  deviceId: string;

  @IsString()
  @MaxLength(64)
  name: string;
}

export class RenameDeviceDto {
  @IsString()
  @MaxLength(64)
  name: string;
}

@UseGuards(JwtAuthGuard)
@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  list() {
    return this.devices.list();
  }

  @Post()
  create(@Body() dto: CreateDeviceDto) {
    return this.devices.create(dto.deviceId, dto.name);
  }

  @Patch(':deviceId')
  rename(@Param('deviceId') deviceId: string, @Body() dto: RenameDeviceDto) {
    return this.devices.rename(deviceId, dto.name);
  }

  @Delete(':deviceId')
  @HttpCode(204)
  remove(@Param('deviceId') deviceId: string) {
    return this.devices.remove(deviceId);
  }
}
