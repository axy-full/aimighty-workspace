/**
 * A zip, written as it streams (brief 2.6).
 *
 * The masters are already compressed, so entries are stored rather than
 * deflated: nothing is gained by squeezing an MP4 twice, and storing means
 * the bytes can be passed straight through. Sizes and checksums are not
 * known until each file has gone by, so each entry carries a data
 * descriptor, which is exactly what that part of the format is for. No
 * dependency: this is a few hundred bytes of header per file.
 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array, seed = 0): number {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

/** A name a zip entry can carry on any machine: no separators, no control characters. */
export function zipName(name: string, fallback: string): string {
  const clean = (name || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/^\.+/, "").trim();
  return clean || fallback;
}

/** Names are unique within one zip: a second "SH010.mp4" becomes "SH010 (2).mp4". */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    const key = raw.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n === 1) return raw;
    const dot = raw.lastIndexOf(".");
    return dot > 0 ? `${raw.slice(0, dot)} (${n})${raw.slice(dot)}` : `${raw} (${n})`;
  });
}

export type ZipEntry = { name: string; body: () => Promise<ReadableStream<Uint8Array> | Uint8Array> };

const u16 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
const u32 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/** DOS time, which is what a zip's own clock is. */
function dosTime(at: Date): { time: number; date: number } {
  return {
    time: ((at.getHours() & 31) << 11) | ((at.getMinutes() & 63) << 5) | ((at.getSeconds() / 2) & 31),
    date: (((at.getFullYear() - 1980) & 127) << 9) | (((at.getMonth() + 1) & 15) << 5) | (at.getDate() & 31),
  };
}

/** The whole archive as one stream: local header, bytes, descriptor, per file, then the directory. */
export function zipStream(entries: ZipEntry[], at = new Date()): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const { time, date } = dosTime(at);
  const dir: Uint8Array[] = [];
  let offset = 0;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const entry of entries) {
          const name = enc.encode(entry.name);
          /* Bit 3 says the sizes follow the data; bit 11 says the name is UTF-8. */
          const flags = 0x0008 | 0x0800;
          const local = join(u32(0x04034b50), u16(20), u16(flags), u16(0), u16(time), u16(date), u32(0), u32(0), u32(0), u16(name.length), u16(0), name);
          controller.enqueue(local);
          const localAt = offset;
          offset += local.length;

          let crc = 0; let size = 0;
          const body = await entry.body();
          if (body instanceof Uint8Array) {
            crc = crc32(body); size = body.length;
            if (size) controller.enqueue(body);
          } else {
            const reader = body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!value?.length) continue;
              crc = crc32(value, crc); size += value.length;
              controller.enqueue(value);
            }
          }
          offset += size;

          const desc = join(u32(0x08074b50), u32(crc), u32(size), u32(size));
          controller.enqueue(desc);
          offset += desc.length;

          dir.push(join(u32(0x02014b50), u16(20), u16(20), u16(flags), u16(0), u16(time), u16(date),
            u32(crc), u32(size), u32(size), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(localAt), name));
        }
        const central = join(...dir);
        controller.enqueue(central);
        controller.enqueue(join(u32(0x06054b50), u16(0), u16(0), u16(dir.length), u16(dir.length), u32(central.length), u32(offset), u16(0)));
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
}
