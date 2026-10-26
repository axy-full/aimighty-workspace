/* Shared pieces of the output-metadata rewriters (lib/storage/outputMetadata.ts). Pure; no I/O. */

/** The file is a known format but laid out in a way the rewriter does not handle (a fragmented MP4, an RF64 WAV, ...). */
export class UnsupportedStructureError extends Error {
  constructor(what: string) { super(`Metadata rewrite not supported: ${what}`); this.name = "UnsupportedStructureError"; }
}

/** The file does not parse as the format its first bytes claim. */
export class MalformedFileError extends Error {
  constructor(what: string) { super(`Malformed file: ${what}`); this.name = "MalformedFileError"; }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (ISO 3309, the one PNG uses). */
export function crc32(...parts: Buffer[]): number {
  let c = 0xffffffff;
  for (const part of parts) for (let i = 0; i < part.length; i++) c = CRC_TABLE[(c ^ part[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export const u32be = (value: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(value >>> 0); return b; };
export const u32le = (value: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0); return b; };
export const u16be = (value: number): Buffer => { const b = Buffer.alloc(2); b.writeUInt16BE(value); return b; };
export const latin1 = (text: string): Buffer => Buffer.from(text, "latin1");

/** The rewritten file did not read back the same media as the delivered one; the delivered file is stored instead. */
export class UnverifiedRewriteError extends Error {
  constructor(what: string) { super(`Rewrite not verified: ${what}`); this.name = "UnverifiedRewriteError"; }
}

/** The most boxes, segments or chunks one rewrite will walk. A real render has hundreds; past this the file is refused (stored as delivered). */
export const MAX_PARTS = 100_000;
/** Counts parts walked during one rewrite and refuses past MAX_PARTS. */
export class PartBudget {
  private used = 0;
  take(what: string): void {
    if (++this.used > MAX_PARTS) throw new UnsupportedStructureError(`more than ${MAX_PARTS} ${what}`);
  }
}
