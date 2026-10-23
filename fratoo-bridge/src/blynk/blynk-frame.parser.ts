import { HEADER_LENGTH } from './blynk.constants';

export interface BlynkFrame {
  type:    number;
  msgId:   number;
  length:  number;
  payload: Buffer;
}

/**
 * Stateful push-based parser. TCP is a byte stream — a single `data` event
 * may contain a partial frame, multiple frames, or both. This accumulates
 * bytes across events and yields only complete frames.
 */
export class BlynkFrameParser {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): BlynkFrame[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const frames: BlynkFrame[] = [];

    while (this.buf.length >= HEADER_LENGTH) {
      const type    = this.buf.readUInt8(0);
      const msgId   = this.buf.readUInt16BE(1);
      const length  = this.buf.readUInt16BE(3);

      if (this.buf.length < HEADER_LENGTH + length) break;

      const payload = this.buf.subarray(HEADER_LENGTH, HEADER_LENGTH + length);
      frames.push({ type, msgId, length, payload: Buffer.from(payload) });
      this.buf = this.buf.subarray(HEADER_LENGTH + length);
    }

    return frames;
  }

  reset(): void {
    this.buf = Buffer.alloc(0);
  }
}
