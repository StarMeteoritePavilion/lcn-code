const MAX_UUID_V7_TIMESTAMP = 0xffffffffffff;
const MAX_SEQUENCE = (1n << 41n) - 1n;

let lastOrdinaryTimestamp = -1;
let sequence: bigint | undefined;

/**
 * 生成带有毫秒时间戳和递增序列的 UUIDv7。
 * @param timestampMs - 显式时间戳，省略时使用当前时间并避免普通调用的时间戳倒退。
 * @returns 带连字符的小写 UUIDv7 字符串。
 * @throws 时间戳不是有效范围内的整数，或生成器序列耗尽时抛出 RangeError；随机数生成错误向调用方传播。
 * @remarks 时间戳范围为 0 到 0xffffffffffff 毫秒，显式传入的时间戳保持原值；调用会更新模块内序列状态。
 */
export function uuidv7(timestampMs?: number): string {
  const requestedTimestamp = timestampMs ?? Date.now();
  if (
    !Number.isInteger(requestedTimestamp) ||
    requestedTimestamp < 0 ||
    requestedTimestamp > MAX_UUID_V7_TIMESTAMP
  ) {
    throw new RangeError(
      `UUIDv7 timestamp must be an integer between 0 and ${MAX_UUID_V7_TIMESTAMP}`,
    );
  }

  const effectiveTimestamp =
    timestampMs === undefined ? Math.max(requestedTimestamp, lastOrdinaryTimestamp) : timestampMs;
  if (timestampMs === undefined) {
    lastOrdinaryTimestamp = effectiveTimestamp;
  }

  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const byteView = new DataView(bytes.buffer);
  if (sequence === undefined) {
    sequence =
      (BigInt(byteView.getUint8(1)) << 32n) |
      (BigInt(byteView.getUint8(2)) << 24n) |
      (BigInt(byteView.getUint8(3)) << 16n) |
      (BigInt(byteView.getUint8(4)) << 8n) |
      BigInt(byteView.getUint8(5));
  } else {
    if (sequence === MAX_SEQUENCE) {
      throw new RangeError("UUIDv7 generator sequence exhausted");
    }
    sequence++;
  }

  const timestamp = BigInt(effectiveTimestamp);
  for (let index = 5; index >= 0; index--) {
    bytes[index] = Number(timestamp >> BigInt((5 - index) * 8)) & 0xff;
  }
  bytes[6] = 0x70 | Number((sequence >> 37n) & 0x0fn);
  bytes[7] = Number((sequence >> 29n) & 0xffn);
  bytes[8] = 0x80 | Number((sequence >> 23n) & 0x3fn);
  bytes[9] = Number((sequence >> 15n) & 0xffn);
  bytes[10] = Number((sequence >> 7n) & 0xffn);
  bytes[11] = Number((sequence & 0x7fn) << 1n) | (byteView.getUint8(11) & 0x01);

  const hex = Array.from(bytes, (byte: number): string => byte.toString(16).padStart(2, "0"));
  const groups = [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10).join(""),
  ];
  return groups.join("-");
}
