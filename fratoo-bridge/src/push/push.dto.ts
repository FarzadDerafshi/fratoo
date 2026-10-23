import { Type } from 'class-transformer';
import { IsBoolean, IsNumber, IsObject, IsOptional, IsString, IsUrl, Max, Min, ValidateNested } from 'class-validator';

class SubscriptionKeysDto {
  @IsString()
  p256dh: string;

  @IsString()
  auth: string;
}

/** The browser's PushSubscription.toJSON(), minus expirationTime. */
export class CreatePushSubscriptionDto {
  @IsUrl({ protocols: ['https'], require_protocol: true })
  endpoint: string;

  @IsObject()
  @ValidateNested()
  @Type(() => SubscriptionKeysDto)
  keys: SubscriptionKeysDto;
}

export class PushEndpointDto {
  @IsString()
  endpoint: string;
}

export class TestPushDto {
  /** Only this device; every subscribed device when left out. */
  @IsOptional()
  @IsString()
  endpoint?: string;
}

/** PATCH /settings/notifications — any subset of NotificationSettings. */
export class UpdateNotificationSettingsDto {
  @IsOptional() @IsBoolean() notifyFermentationStarted?: boolean;
  @IsOptional() @IsBoolean() notifyDeviceOffline?: boolean;
  @IsOptional() @IsBoolean() notifyNoStart?: boolean;
  @IsOptional() @IsBoolean() notifyTemperature?: boolean;
  @IsOptional() @IsBoolean() notifyPeakPassed?: boolean;
  @IsOptional() @IsBoolean() notifyLooksFinished?: boolean;
  @IsOptional() @IsBoolean() notifyStalled?: boolean;
  @IsOptional() @IsBoolean() notifyDeviceRebooted?: boolean;

  @IsOptional() @IsNumber() @Min(10) @Max(1440) offlineMinutes?: number;
  @IsOptional() @IsNumber() @Min(1) @Max(168) noStartHours?: number;
  @IsOptional() @IsNumber() @Min(-10) @Max(60) tempMinC?: number;
  @IsOptional() @IsNumber() @Min(-10) @Max(60) tempMaxC?: number;
  @IsOptional() @IsNumber() @Min(10) @Max(90) peakDropPct?: number;
  @IsOptional() @IsNumber() @Min(1) @Max(48) peakDropHours?: number;
  @IsOptional() @IsNumber() @Min(0.1) @Max(50) finishedBpm?: number;
  @IsOptional() @IsNumber() @Min(1) @Max(168) finishedHours?: number;
  @IsOptional() @IsNumber() @Min(1) @Max(168) stallHours?: number;
  @IsOptional() @IsNumber() @Min(10) @Max(100) stallPctOfExpected?: number;
}
