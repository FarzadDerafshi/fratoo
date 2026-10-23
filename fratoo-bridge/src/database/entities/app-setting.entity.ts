import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

// Generic key/JSON settings store (db/init/002_abv_calibration.sql). Only
// 'fermentation' exists so far — see SettingsService.
@Entity({ name: 'app_settings' })
export class AppSettingEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  key: string;

  @Column({ type: 'jsonb' })
  value: Record<string, unknown>;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
