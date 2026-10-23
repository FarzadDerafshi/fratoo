import { IsIn, IsISO8601, IsOptional, IsString, ValidateIf } from 'class-validator';
import { BATCH_EVENT_KINDS, type BatchEventKind } from '../../database/entities/batch-event.entity';

export class CreateBatchEventDto {
  @IsISO8601()
  occurredAt: string;

  @IsIn(BATCH_EVENT_KINDS)
  kind: BatchEventKind;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateBatchEventDto {
  @IsOptional()
  @IsISO8601()
  occurredAt?: string;

  @IsOptional()
  @IsIn(BATCH_EVENT_KINDS)
  kind?: BatchEventKind;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  notes?: string | null;
}
