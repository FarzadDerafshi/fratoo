import { BlynkCmd, HEADER_LENGTH } from './blynk.constants';
import { BlynkFrame, BlynkFrameParser } from './blynk-frame.parser';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildFrame(type: number, msgId: number, payload: Buffer | string = Buffer.alloc(0)): Buffer {
  const p   = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const buf = Buffer.allocUnsafe(HEADER_LENGTH + p.length);
  buf.writeUInt8(type, 0);
  buf.writeUInt16BE(msgId, 1);
  buf.writeUInt16BE(p.length, 3);
  p.copy(buf, HEADER_LENGTH);
  return buf;
}

function ping(msgId = 1): Buffer {
  return buildFrame(BlynkCmd.PING, msgId);
}

function login(token = 'a'.repeat(32), msgId = 1): Buffer {
  return buildFrame(BlynkCmd.LOGIN, msgId, token);
}

function hardware(payload: string, msgId = 1): Buffer {
  return buildFrame(BlynkCmd.HARDWARE, msgId, payload);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BlynkFrameParser', () => {
  let parser: BlynkFrameParser;

  beforeEach(() => {
    parser = new BlynkFrameParser();
  });

  // ── Single frame ──────────────────────────────────────────────────────────

  describe('single complete frame in one push', () => {
    it('returns one frame for a zero-payload Ping', () => {
      const frames = parser.push(ping(1));

      expect(frames).toHaveLength(1);
      expect(frames[0].type).toBe(BlynkCmd.PING);
      expect(frames[0].msgId).toBe(1);
      expect(frames[0].length).toBe(0);
      expect(frames[0].payload.length).toBe(0);
    });

    it('returns one frame for a Login with a 32-byte auth token', () => {
      const token  = 'abcdef1234567890abcdef1234567890';
      const frames = parser.push(login(token, 2));

      expect(frames).toHaveLength(1);
      expect(frames[0].type).toBe(BlynkCmd.LOGIN);
      expect(frames[0].msgId).toBe(2);
      expect(frames[0].length).toBe(32);
      expect(frames[0].payload.toString('utf8')).toBe(token);
    });

    it('returns one frame for a Hardware virtual-write payload', () => {
      const payload = 'vw\x00V1\x005.20';
      const frames  = parser.push(hardware(payload, 3));

      expect(frames).toHaveLength(1);
      expect(frames[0].type).toBe(BlynkCmd.HARDWARE);
      expect(frames[0].payload.toString('utf8')).toBe(payload);
    });
  });

  // ── Field decoding ────────────────────────────────────────────────────────

  describe('frame field decoding', () => {
    it('decodes msgId as big-endian uint16 (0x01FF → 511)', () => {
      const buf    = buildFrame(BlynkCmd.PING, 0x01ff);
      const frames = parser.push(buf);

      expect(frames[0].msgId).toBe(511);
    });

    it('decodes the maximum msgId (0xFFFF → 65535)', () => {
      const frames = parser.push(buildFrame(BlynkCmd.PING, 0xffff));
      expect(frames[0].msgId).toBe(65535);
    });

    it('exposes length equal to the byte length of the payload', () => {
      const payload = 'vw\x00V4\x0021.5';
      const frames  = parser.push(hardware(payload));

      expect(frames[0].length).toBe(Buffer.byteLength(payload, 'utf8'));
    });
  });

  // ── Multi-frame in one push ───────────────────────────────────────────────

  describe('multiple complete frames concatenated in one push', () => {
    it('returns all frames in order', () => {
      const chunk = Buffer.concat([
        ping(1),
        login('a'.repeat(32), 2),
        hardware('vw\x00V1\x009.1', 3),
      ]);

      const frames = parser.push(chunk);

      expect(frames).toHaveLength(3);
      expect(frames[0].type).toBe(BlynkCmd.PING);
      expect(frames[1].type).toBe(BlynkCmd.LOGIN);
      expect(frames[2].type).toBe(BlynkCmd.HARDWARE);
    });

    it('preserves msgId sequence across frames', () => {
      const chunk  = Buffer.concat([ping(10), ping(11), ping(12)]);
      const frames = parser.push(chunk);

      expect(frames.map((f) => f.msgId)).toEqual([10, 11, 12]);
    });
  });

  // ── TCP fragmentation ────────────────────────────────────────────────────

  describe('fragmented delivery across multiple pushes', () => {
    it('yields no frames for an incomplete header and one frame once complete', () => {
      const full    = ping(1);
      const partial = full.subarray(0, 3); // only 3 of 5 header bytes
      const rest    = full.subarray(3);

      expect(parser.push(partial)).toHaveLength(0);
      expect(parser.push(rest)).toHaveLength(1);
    });

    it('yields no frames when header is complete but payload is incomplete', () => {
      const full    = hardware('vw\x00V1\x005.0', 1);
      const header  = full.subarray(0, HEADER_LENGTH);         // 5 bytes
      const partial = full.subarray(HEADER_LENGTH, HEADER_LENGTH + 2); // 2 of N payload bytes
      const rest    = full.subarray(HEADER_LENGTH + 2);

      expect(parser.push(header)).toHaveLength(0);
      expect(parser.push(partial)).toHaveLength(0);

      const frames = parser.push(rest);
      expect(frames).toHaveLength(1);
      expect(frames[0].payload.toString('utf8')).toBe('vw\x00V1\x005.0');
    });

    it('correctly parses a second frame that arrives split across two pushes', () => {
      const frame1   = ping(1);
      const frame2   = login('b'.repeat(32), 2);
      const boundary = HEADER_LENGTH + 10; // split frame2 mid-payload

      const chunk1 = Buffer.concat([frame1, frame2.subarray(0, boundary)]);
      const chunk2 = frame2.subarray(boundary);

      const first  = parser.push(chunk1);
      const second = parser.push(chunk2);

      expect(first).toHaveLength(1);
      expect(first[0].type).toBe(BlynkCmd.PING);

      expect(second).toHaveLength(1);
      expect(second[0].type).toBe(BlynkCmd.LOGIN);
      expect(second[0].payload.toString('utf8')).toBe('b'.repeat(32));
    });

    it('accumulates across many single-byte pushes', () => {
      const full   = ping(42);
      const frames: BlynkFrame[] = [];

      for (let i = 0; i < full.length; i++) {
        frames.push(...parser.push(full.subarray(i, i + 1)));
      }

      expect(frames).toHaveLength(1);
      expect(frames[0].msgId).toBe(42);
    });
  });

  // ── Empty / no-op inputs ─────────────────────────────────────────────────

  describe('edge cases', () => {
    it('returns an empty array for an empty buffer push', () => {
      expect(parser.push(Buffer.alloc(0))).toEqual([]);
    });

    it('returns an empty array when only 4 bytes are present (incomplete header)', () => {
      expect(parser.push(Buffer.alloc(4))).toEqual([]);
    });
  });

  // ── Payload isolation ────────────────────────────────────────────────────

  describe('payload buffer isolation', () => {
    it('returned payload is independent of the original chunk buffer', () => {
      const chunk  = hardware('vw\x00V1\x001.0', 1);
      const frames = parser.push(chunk);

      // Mutate the original chunk after parsing
      chunk.fill(0xff);

      expect(frames[0].payload.toString('utf8')).toBe('vw\x00V1\x001.0');
    });
  });

  // ── reset() ───────────────────────────────────────────────────────────────

  describe('reset()', () => {
    it('discards accumulated partial bytes so no stale frame is emitted', () => {
      const full = ping(1);
      parser.push(full.subarray(0, 3)); // accumulate partial header

      parser.reset();

      // Push the tail — without reset this would complete the frame; after
      // reset the tail bytes alone are insufficient for a full frame.
      expect(parser.push(full.subarray(3))).toHaveLength(0);
    });

    it('allows clean parsing after a reset', () => {
      parser.push(ping(1).subarray(0, 3));
      parser.reset();

      const frames = parser.push(ping(99));
      expect(frames).toHaveLength(1);
      expect(frames[0].msgId).toBe(99);
    });
  });
});
