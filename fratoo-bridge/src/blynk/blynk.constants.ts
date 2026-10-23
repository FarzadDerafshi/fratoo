export const BLYNK_TCP_PORT = 1234;
export const HEADER_LENGTH = 5;

export const BlynkCmd = {
  RESPONSE: 0x00,
  LOGIN:    0x02,
  PING:     0x06,
  INTERNAL: 0x11,
  HW_SYNC:  0x10,
  HARDWARE: 0x14,
} as const;

export const BlynkStatus = {
  OK: 200,
} as const;
