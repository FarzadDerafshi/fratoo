import { IsBoolean, IsIn, IsISO8601, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CreateBatchDto {
  @IsString()
  batchCode: string;

  @IsOptional()
  @IsString()
  deviceId?: string;

  @IsOptional()
  @IsString()
  brewType?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  volumeLiters?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  addedSugarG?: number;

  @IsOptional()
  @IsString()
  notes?: string;

  // ABV model inputs — see src/fermentation/abv-model.ts.
  @IsOptional()
  @IsNumber()
  @Min(0)
  ogValue?: number;

  @IsOptional()
  @IsIn(['sg', 'brix'])
  ogUnit?: 'sg' | 'brix';

  @IsOptional()
  @IsBoolean()
  ogIncludesSugar?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  targetAbv?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  bubbleVolumeMl?: number;

  // Brew log — see db/init/003_brew_log.sql. Bottling and tasting fields
  // are only on UpdateBatchDto: nobody knows them when the batch starts.
  @IsOptional()
  @IsString()
  @MaxLength(128)
  yeastStrain?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  yeastAttenuation?: number;

  @IsOptional()
  @IsISO8601()
  pitchedAt?: string;

  @IsOptional()
  @IsNumber()
  @Min(-10)
  @Max(60)
  pitchTempC?: number;

  @IsOptional()
  @IsString()
  hops?: string;
}
