import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

// Known airlocks (db/init/006_devices.sql). Batches and readings still
// refer to a device by its token (device_id); this only adds a name and lets
// the dashboard offer a list — see DevicesService.
@Entity({ name: 'devices' })
export class DeviceEntity {
  @PrimaryColumn({ name: 'device_id', type: 'varchar', length: 64 })
  deviceId: string;

  /** Chosen in Settings → Devices; '' = no name yet (the short token is shown). */
  @Column({ type: 'varchar', length: 64, default: '' })
  name: string;

  /** First reading (or batch) seen, or when it was added by hand. */
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
