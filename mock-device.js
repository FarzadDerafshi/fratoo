'use strict';
// Standalone mock Plaato Airlock — simulates Blynk legacy binary protocol.
// Runs with plain Node, no compilation: node mock-device.js
//
// Real device pin mapping (confirmed via PlaatoStructure.java — PLAATO-Technologies/plaato-b2c-server):
//   V99  = Firmware transmission sequence counter  (increments by 1 per wake/send cycle, no fermentation value)
//   V100 = Cumulative bubble counter  (monotonic; resets on device reboot)
//   V101 = Raw PCB temperature °C  (apply correction: 0.9133 * raw - 1.145 for true vessel temp)
//
// This mock sends the same three pins every TELEMETRY_MS, with BUBBLES_PER_SEND
// (default 5, set 0 to simulate the lag phase) added to the counter each time.

const net = require('net');

const CMD = { RESPONSE: 0x00, LOGIN: 0x02, PING: 0x06, HW_SYNC: 0x10, HARDWARE: 0x14 };
const HEADER_LEN = 5;
const HOST       = process.env.BLYNK_HOST || 'localhost';
const PORT       = Number(process.env.BLYNK_PORT) || 1234;
const TOKEN      = process.env.BLYNK_TOKEN || 'aaaabbbbccccddddeeeeffffaaaabbbb';
const TELEMETRY_MS = Number(process.env.TELEMETRY_MS) || 3_000;
const PING_MS      = Number(process.env.PING_MS)      || 10_000;
const BUBBLES_PER_SEND = process.env.BUBBLES_PER_SEND !== undefined ? Number(process.env.BUBBLES_PER_SEND) : 5;

// ── Frame construction ────────────────────────────────────────────────────────

let _msgId = 1;
const nextId = () => _msgId++;

function buildFrame(type, msgId, textPayload) {
  const body = textPayload ? Buffer.from(textPayload, 'utf8') : Buffer.alloc(0);
  const buf  = Buffer.allocUnsafe(HEADER_LEN + body.length);
  buf.writeUInt8(type, 0);
  buf.writeUInt16BE(msgId, 1);
  buf.writeUInt16BE(body.length, 3);
  body.copy(buf, HEADER_LEN);
  return buf;
}

// Null-byte delimited: "vw\0<pin>\0<value>"
const buildHw = (msgId, pin, value) =>
  buildFrame(CMD.HARDWARE, msgId, `vw\0${pin}\0${value}`);

// ── Incoming frame parser ─────────────────────────────────────────────────────
// RESPONSE frames are 5 bytes total (no body); the status lives in bytes 3-4.
// All other frames: bytes 3-4 = payload length, followed by that many bytes.

let _rxBuf = Buffer.alloc(0);

function parseIncoming(chunk) {
  _rxBuf = Buffer.concat([_rxBuf, chunk]);
  const frames = [];
  while (_rxBuf.length >= HEADER_LEN) {
    const type  = _rxBuf.readUInt8(0);
    const msgId = _rxBuf.readUInt16BE(1);
    const word3 = _rxBuf.readUInt16BE(3);

    if (type === CMD.RESPONSE) {
      frames.push({ type, msgId, status: word3 });
      _rxBuf = _rxBuf.subarray(HEADER_LEN);
    } else {
      if (_rxBuf.length < HEADER_LEN + word3) break;
      const payload = Buffer.from(_rxBuf.subarray(HEADER_LEN, HEADER_LEN + word3));
      frames.push({ type, msgId, length: word3, payload });
      _rxBuf = _rxBuf.subarray(HEADER_LEN + word3);
    }
  }
  return frames;
}

// ── Telemetry helpers ─────────────────────────────────────────────────────────

let sequence = 0;
let bubbles  = 0;

// Raw PCB value whose corrected vessel temperature is 18–22 °C.
function randomRawTemp() { return ((Math.random() * 4 + 18 + 1.145) / 0.9133).toFixed(1); }

function sendReadings(socket) {
  sequence += 1;
  bubbles  += BUBBLES_PER_SEND;
  const readings = [
    { pin: '99',  value: String(sequence), label: 'Sequence'          },
    { pin: '100', value: String(bubbles),  label: 'Bubble counter'    },
    { pin: '101', value: randomRawTemp(),  label: 'Raw PCB temp °C'   },
  ];
  for (const { pin, value, label } of readings) {
    const id = nextId();
    socket.write(buildHw(id, pin, value));
    log(`→ HARDWARE  V${pin}=${value.padStart(5)}  (${label})  msgId=${id}`);
  }
}

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 23);
  console.log(`[${ts}] ${msg}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

log(`Connecting to ${HOST}:${PORT} …`);
const socket = net.createConnection(PORT, HOST);

socket.on('connect', () => {
  log(`Connected`);
  const id = nextId();
  socket.write(buildFrame(CMD.LOGIN, id, TOKEN));
  log(`→ LOGIN  token=${TOKEN.slice(0, 8)}…  msgId=${id}`);
});

let handshakeDone = false;
let telemetryTimer;
let pingTimer;

socket.on('data', (chunk) => {
  for (const f of parseIncoming(chunk)) {
    if (f.type === CMD.RESPONSE) {
      log(`← RESPONSE  status=${f.status}  msgId=${f.msgId}`);

      if (!handshakeDone) {
        handshakeDone = true;

        const id = nextId();
        socket.write(buildFrame(CMD.HW_SYNC, id));
        log(`→ HW_SYNC  msgId=${id}`);

        // Brief pause then kick off continuous telemetry
        setTimeout(() => {
          log(`\nHandshake complete — telemetry every ${TELEMETRY_MS}ms, PING every ${PING_MS}ms\n`);
          sendReadings(socket);
          telemetryTimer = setInterval(() => sendReadings(socket), TELEMETRY_MS);
          pingTimer = setInterval(() => {
            const id = nextId();
            socket.write(buildFrame(CMD.PING, id));
            log(`→ PING  msgId=${id}`);
          }, PING_MS);
        }, 300);
      }
    } else {
      log(`← frame type=0x${f.type.toString(16).padStart(2, '0')}  msgId=${f.msgId}  len=${f.length}`);
    }
  }
});

socket.on('close', () => {
  clearInterval(telemetryTimer);
  clearInterval(pingTimer);
  log('Connection closed');
});

socket.on('error', (err) => {
  log(`ERROR: ${err.message}`);
  process.exit(1);
});

process.on('SIGINT', () => {
  log('Shutting down …');
  socket.destroy();
  process.exit(0);
});
