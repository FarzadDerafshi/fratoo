import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

// Nullable fields (endedAt, volumeLiters, addedSugarG) mirror update_batch()
// in the WordPress plugin, which needed special-casing to actually clear a
// column to NULL (wpdb quirk). TypeORM has no such quirk — passing `null`
// through to a `.save()`/`.update()` call writes NULL directly — but the
// DTO still needs ValidateIf to let `null` itself pass validation, since
// `@IsOptional()` alone only skips `undefined`.
export class UpdateBatchDto {
  @IsOptional()
  @IsString()
  batchCode?: string;

  @IsOptional()
  @IsString()
  deviceId?: string;

  @IsOptional()
  @IsString()
  brewType?: string;

  // Unlike endedAt, startedAt is never null — a batch always has a start.
  // Lets a batch's window be backdated to match when fermentation actually
  // began (e.g. readings existed before the batch record was created, or
  // before it was migrated in from WordPress), which otherwise has no way
  // to be corrected after the fact.
  @IsOptional()
  @IsISO8601()
  startedAt?: string;

  @IsOptional()
  @IsIn(['active', 'completed'])
  status?: string;

  // Completing a batch: pass an ISO timestamp (or omit to use "now" — see
  // BatchesService.complete()). Reopening one: pass null explicitly.
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsISO8601()
  endedAt?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Min(0)
  volumeLiters?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Min(0)
  addedSugarG?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  notes?: string | null;

  // ABV model inputs — see src/fermentation/abv-model.ts. ogValue and
  // ogUnit are cleared together (null) to remove the OG.
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Min(0)
  ogValue?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsIn(['sg', 'brix'])
  ogUnit?: 'sg' | 'brix' | null;

  @IsOptional()
  @IsBoolean()
  ogIncludesSugar?: boolean;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Min(0)
  @Max(100)
  targetAbv?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Min(0.01)
  bubbleVolumeMl?: number | null;

  // Brew log — see db/init/003_brew_log.sql. All clearable with null.
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(128)
  yeastStrain?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Min(1)
  @Max(100)
  yeastAttenuation?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsISO8601()
  pitchedAt?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Min(-10)
  @Max(60)
  pitchTempC?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  hops?: string | null;

  /** Temperature alert limits for this batch (°C at the airlock); null = the app-wide setting. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Min(-10)
  @Max(60)
  alertTempMinC?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Min(-10)
  @Max(60)
  alertTempMaxC?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Min(0)
  primingSugarG?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Min(0)
  bottledVolumeL?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  bottleCount?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  tastingNotes?: string | null;
}
