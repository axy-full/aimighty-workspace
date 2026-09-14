import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function encodeBase32(bytes: Uint8Array): string {
  let value = 0,
    bits = 0,
    result = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(value >>> bits) & 31];
    }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}
function decodeBase32(secret: string): Buffer {
  if (!/^[A-Z2-7]{16,128}$/.test(secret))
    throw new Error("Invalid authenticator secret");
  let value = 0,
    bits = 0;
  const bytes: number[] = [];
  for (const char of secret) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  return Buffer.from(bytes);
}
export const newTotpSecret = () => encodeBase32(randomBytes(20));
/** RFC 6238 / RFC 4226; Node's HMAC primitive, 64-bit moving counter. */
export function totpAt(secret: string, at: number, digits: 6 | 8 = 6): string {
  if (!Number.isSafeInteger(at) || at < 0)
    throw new Error("Invalid authenticator time");
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac("sha1", decodeBase32(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  return String(
    (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits,
  ).padStart(digits, "0");
}
/** One adjacent step tolerates clock drift. The caller atomically persists the
 * accepted counter; equal/older codes cannot be replayed across sessions. */
export function matchingTotpCounter(
  secret: string,
  code: string,
  at: number,
  lastCounter: number,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(at / 30_000);
  let match: number | null = null;
  for (const counter of [current - 1, current, current + 1]) {
    if (counter < 0) continue;
    const equal = timingSafeEqual(
      Buffer.from(totpAt(secret, counter * 30_000)),
      Buffer.from(code),
    );
    if (equal && counter > lastCounter) match = counter;
  }
  return match;
}
