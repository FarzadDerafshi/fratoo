import * as net from 'net';
import { EventEmitter } from 'events';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { BlynkFrame, BlynkFrameParser } from './blynk-frame.parser';
import {
  BLYNK_TCP_PORT,
  HEADER_LENGTH,
  BlynkCmd,
  BlynkStatus,
} from './blynk.constants';

export interface BlynkReading {
  deviceId:   string;
  pin:        string;
  value:      string;
  receivedAt: Date;
}

@Injectable()
export class BlynkService extends EventEmitter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BlynkService.name);
  private server: net.Server;

  onModuleInit(): void {
    this.server = net.createServer((socket) => this.handleConnection(socket));

    this.server.on('error', (err) =>
      this.logger.error(`Server error: ${err.message}`),
    );

    this.server.listen(BLYNK_TCP_PORT, () =>
      this.logger.log(`Blynk TCP listener active on port ${BLYNK_TCP_PORT}`),
    );
  }

  onModuleDestroy(): void {
    this.server?.close();
  }

  private handleConnection(socket: net.Socket): void {
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    this.logger.log(`Device connected: ${remote}`);

    const parser = new BlynkFrameParser();
    let deviceId = '';

    socket.on('data', (chunk: Buffer) => {
      const frames = parser.push(chunk);

      for (const frame of frames) {
        // ── Critical path ──────────────────────────────────────────────────
        // Ping ACK is sent synchronously here, before any other processing.
        // socket.write() buffers directly into the kernel send buffer without
        // yielding to the event loop. This guarantees the ACK is dispatched
        // within microseconds, well inside the ~30 s watchdog window.
        if (frame.type === BlynkCmd.PING) {
          socket.write(this.buildResponse(frame.msgId, BlynkStatus.OK));
          continue;
        }
        // ───────────────────────────────────────────────────────────────────

        // Capture token here so it's available as a closure variable for all
        // subsequent HARDWARE frames on this socket without changing dispatchFrame's
        // return type.
        if (frame.type === BlynkCmd.LOGIN) {
          deviceId = frame.payload.toString('utf8');
          this.logger.log(`Auth from ${remote} — token: ${deviceId.slice(0, 8)}...`);
          socket.write(this.buildResponse(frame.msgId, BlynkStatus.OK));
          continue;
        }

        this.dispatchFrame(socket, frame, remote, deviceId);
      }
    });

    socket.on('close', () => {
      this.logger.warn(`Device disconnected: ${remote}`);
      parser.reset();
    });

    socket.on('error', (err) =>
      this.logger.error(`Socket error [${remote}]: ${err.message}`),
    );
  }

  private dispatchFrame(socket: net.Socket, frame: BlynkFrame, remote: string, deviceId: string): void {
    switch (frame.type) {
      case BlynkCmd.INTERNAL:
        socket.write(this.buildResponse(frame.msgId, BlynkStatus.OK));
        break;

      case BlynkCmd.HW_SYNC:
        socket.write(this.buildResponse(frame.msgId, BlynkStatus.OK));
        break;

      case BlynkCmd.HARDWARE: {
        const reading = this.parseHardwarePayload(frame.payload, deviceId);
        if (reading) {
          this.logger.debug(`Pin ${reading.pin} = ${reading.value}`);
          this.emit('reading', reading);
        }
        break;
      }

      default:
        this.logger.debug(`Unhandled frame 0x${frame.type.toString(16).padStart(2, '0')}`);
    }
  }

  private parseHardwarePayload(payload: Buffer, deviceId: string): BlynkReading | null {
    // Payload tokens are null-byte delimited: "vw\0<pin>\0<value>"
    // Pin arrives as a bare integer string ("1", "4"); normalise to "V1", "V4".
    const tokens = payload.toString('utf8').split('\0');
    if (tokens[0] !== 'vw' || tokens.length < 3) return null;

    const rawPin   = tokens[1];
    const pin      = rawPin.startsWith('V') ? rawPin : `V${rawPin}`;
    const rawValue = tokens[2];

    // Hardware error codes (e.g. 'E1', 'E2') are non-numeric. Drop them here so
    // they never enter the queue and never trigger a WP REST 400.
    if (!isFinite(parseFloat(rawValue))) {
      this.logger.warn(`Pin ${pin} — non-numeric value "${rawValue}" dropped`);
      return null;
    }

    return { deviceId, pin, value: rawValue, receivedAt: new Date() };
  }

  private buildResponse(msgId: number, status: number): Buffer {
    // Blynk Response frame: 5 bytes, no payload.
    // The status code occupies the length field (bytes 3–4).
    const buf = Buffer.allocUnsafe(HEADER_LENGTH);
    buf.writeUInt8(BlynkCmd.RESPONSE, 0);
    buf.writeUInt16BE(msgId, 1);
    buf.writeUInt16BE(status, 3);
    return buf;
  }
}
