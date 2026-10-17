import { crc32, inflateRawSync } from "node:zlib";
import {
  MAX_ZIP_ENTRIES,
  MAX_ZIP_ENTRY_BYTES,
  MAX_ZIP_RATIO,
  MAX_ZIP_TOTAL_BYTES,
  RATIO_FLOOR_BYTES,
} from "./limits";
import { DocImportError } from "./types";

/**
 * A zip reader for Office packages (.docx, .pptx, .xlsx) that decides how
 * much it will decompress BEFORE it decompresses anything.
 *
 * From the central directory alone it refuses: more than MAX_ZIP_ENTRIES
 * entries; a declared total past MAX_ZIP_TOTAL_BYTES; an entry past
 * MAX_ZIP_ENTRY_BYTES; a ratio past MAX_ZIP_RATIO for entries above
 * RATIO_FLOOR_BYTES; encryption; Zip64; methods other than stored/deflate;
 * duplicate or path-like names; entries whose data overlap (the
 * "overlapping files" bomb) or run into the directory.
 *
 * Reading an entry inflates with Node's `maxOutputLength` set to the size
 * the directory declared, so a lying header stops at the declared size
 * instead of filling memory, and the result must match both the declared
 * size and the CRC-32. Nothing is ever written to disk by entry name.
 */

export type ZipEntry = {
  name: string;
  method: 0 | 8;
  crc: number;
  compressedSize: number;
  size: number;
  dataStart: number;
};

export type ZipArchive = {
  entries: Map<string, ZipEntry>;
  /** Sum of the declared uncompressed sizes. */
  totalSize: number;
  read(name: string, maxBytes?: number): Buffer;
};

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

const damaged = (label: string) =>
  new DocImportError("damaged", `${label} is damaged or incomplete. Nothing was imported.`);

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export type ZipLimits = {
  maxEntries?: number;
  maxTotalBytes?: number;
  maxEntryBytes?: number;
  maxRatio?: number;
};

export function openZip(buf: Buffer, label: string, limits: ZipLimits = {}): ZipArchive {
  const maxEntries = limits.maxEntries ?? MAX_ZIP_ENTRIES;
  const maxTotal = limits.maxTotalBytes ?? MAX_ZIP_TOTAL_BYTES;
  const maxEntry = limits.maxEntryBytes ?? MAX_ZIP_ENTRY_BYTES;
  const maxRatio = limits.maxRatio ?? MAX_ZIP_RATIO;
  if (!isZip(buf)) throw damaged(label);

  // The end-of-central-directory record sits in the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw damaged(label);
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const onDisk = buf.readUInt16LE(eocd + 8);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
    throw new DocImportError("unsupported", `${label} uses a zip format the importer does not read. Save it again and retry.`);
  if (disk !== 0 || cdDisk !== 0 || onDisk !== count) throw damaged(label);
  if (count > maxEntries)
    throw new DocImportError("limit", `${label} holds more than ${maxEntries} parts. Nothing was imported.`);
  if (cdOffset + cdSize > eocd) throw damaged(label);

  const entries = new Map<string, ZipEntry>();
  const spans: [number, number][] = [];
  let totalSize = 0;
  let at = cdOffset;
  for (let n = 0; n < count; n++) {
    if (at + 46 > eocd || buf.readUInt32LE(at) !== CENTRAL) throw damaged(label);
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const compressedSize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const localOffset = buf.readUInt32LE(at + 42);
    const nameEnd = at + 46 + nameLength;
    if (nameEnd > eocd) throw damaged(label);
    const name = buf.toString(flags & 0x800 ? "utf8" : "latin1", at + 46, nameEnd);
    at = nameEnd + extraLength + commentLength;

    if (flags & 0x1) throw new DocImportError("encrypted", `${label} is password protected. Save an unprotected copy and retry.`);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff)
      throw new DocImportError("unsupported", `${label} uses a zip format the importer does not read. Save it again and retry.`);
    if (method !== 0 && method !== 8)
      throw new DocImportError("unsupported", `${label} uses a compression the importer does not read. Save it again and retry.`);
    if (!name || name.includes("\0") || name.includes("\\") || name.startsWith("/") || name.split("/").some((part) => part === ".."))
      throw new DocImportError("unsafe", `${label} contains a part with an unsafe name. Nothing was imported.`);
    if (entries.has(name)) throw new DocImportError("unsafe", `${label} contains the same part twice. Nothing was imported.`);
    if (size > maxEntry)
      throw new DocImportError("limit", `${label} has a part larger than the importer reads. Nothing was imported.`);
    if (size > RATIO_FLOOR_BYTES && size / Math.max(1, compressedSize) > maxRatio)
      throw new DocImportError("unsafe", `${label} expands far more than a real document does. Nothing was imported.`);
    if (method === 0 && size !== compressedSize) throw damaged(label);
    totalSize += size;
    if (totalSize > maxTotal)
      throw new DocImportError("limit", `${label} expands past the importer's size limit. Nothing was imported.`);

    // The local header gives where this entry's data really starts.
    if (localOffset + 30 > cdOffset || buf.readUInt32LE(localOffset) !== LOCAL) throw damaged(label);
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const localName = buf.toString(flags & 0x800 ? "utf8" : "latin1", localOffset + 30, localOffset + 30 + localNameLength);
    if (localName !== name) throw damaged(label);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > cdOffset) throw damaged(label);
    spans.push([localOffset, dataStart + compressedSize]);
    entries.set(name, { name, method: method as 0 | 8, crc, compressedSize, size, dataStart });
  }
  // No two entries may share bytes: that is how a small zip claims many large files.
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++)
    if (spans[i][0] < spans[i - 1][1])
      throw new DocImportError("unsafe", `${label} reuses the same data for several parts. Nothing was imported.`);

  return {
    entries,
    totalSize,
    read(name: string, maxBytes = maxEntry) {
      const entry = entries.get(name);
      if (!entry) throw damaged(label);
      if (entry.size > maxBytes)
        throw new DocImportError("limit", `${label} has a part larger than the importer reads. Nothing was imported.`);
      const raw = buf.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
      let out: Buffer;
      if (entry.method === 0) out = Buffer.from(raw);
      else {
        try {
          // Never more than the declared size: a header that lies stops here.
          out = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) });
        } catch {
          throw damaged(label);
        }
      }
      if (out.length !== entry.size || crc32(out) !== entry.crc) throw damaged(label);
      return out;
    },
  };
}

/** The directory part of a zip path ("ppt/slides/slide1.xml" → "ppt/slides"). */
export const zipDir = (name: string) => name.slice(0, Math.max(0, name.lastIndexOf("/")));

/**
 * Resolve a relationship target against the part that names it, inside the
 * package only. Returns null for anything that would leave the package.
 */
export function resolvePartPath(baseDir: string, target: string): string | null {
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.includes("\\")) return null;
  const parts = target.startsWith("/") ? [] : baseDir.split("/").filter(Boolean);
  for (const encoded of target.replace(/^\/+/, "").split("/")) {
    // Decode first, so "%2e%2e" is judged as the ".." it is.
    const part = decodeURIComponentSafe(encoded);
    if (part.includes("/") || part.includes("\\") || part.includes("\0")) return null;
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

function decodeURIComponentSafe(part: string) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}
