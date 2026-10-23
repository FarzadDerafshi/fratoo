import { IsBoolean, IsIn, IsISO8601, IsNumber, IsOptional, IsString, Max, Min, ValidateIf } from 'class-validator';

export class CreateGravityReadingDto {
  @IsISO8601()
  measuredAt: string;

  @IsNumber()
  @Min(0)
  value: number;

  @IsIn(['sg', 'brix'])
  unit: 'sg' | 'brix';

  @IsOptional()
  @IsBoolean()
  excludeFromCalibration?: boolean;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateGravityReadingDto {
  @IsOptional()
  @IsISO8601()
  measuredAt?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  value?: number;

  @IsOptional()
  @IsIn(['sg', 'brix'])
  unit?: 'sg' | 'brix';

  @IsOptional()
  @IsBoolean()
  excludeFromCalibration?: boolean;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  notes?: string | null;
}

/** Partial update — omitted keys keep their current value. See fermentation-settings.ts for what each one does. */
export class UpdateFermentationSettingsDto {
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(20)
  defaultBubbleVolumeMl?: number;

  @IsOptional()
  @IsIn(['auto', 'default-only'])
  calibrationMode?: 'auto' | 'default-only';

  @IsOptional()
  @IsNumber()
  @Min(0.8)
  @Max(1.3)
  wortCorrectionFactor?: number;

  @IsOptional()
  @IsIn(['standard', 'alternate'])
  abvFormula?: 'standard' | 'alternate';

  @IsOptional()
  @IsNumber()
  @Min(50)
  @Max(120)
  pressureKpa?: number;

  @IsOptional()
  @IsIn(['measured', 'fixed'])
  temperatureSource?: 'measured' | 'fixed';

  @IsOptional()
  @IsNumber()
  @Min(-5)
  @Max(45)
  fixedTemperatureC?: number;

  @IsOptional()
  @IsBoolean()
  dissolvedCo2Enabled?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0.5)
  @Max(1.5)
  co2PerEthanolMass?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  sugarPointsPerKgPerLiter?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  expectedAttenuation?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.95)
  @Max(1.05)
  minPossibleFg?: number;

  @IsOptional()
  @IsBoolean()
  capAbvToOg?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  minCalibrationBubbles?: number;
}
