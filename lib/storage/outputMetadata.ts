import { cleanJpeg, cleanPng } from "./metadataStills";
import { cleanMp3, cleanMp4, cleanWav } from "./metadataMedia";
import { UnsupportedStructureError } from "./metadataBytes";

/**
 * What happens to a finished output's embedded metadata before it reaches
 * storage: one server switch, OUTPUT_METADATA, read only on the server.
 *
 *   keep    (the default) nothing is touched: the bytes a vendor delivered are
 *           the bytes stored, exactly as before this switch existed.
 *   marker  every metadata field is removed and ONE machine-readable marker is
 *           written in its place: an XMP packet holding only the IPTC Digital
 *           Source Type `trainedAlgorithmicMedia` (the vocabulary C2PA's own
 *           actions use). It names no vendor, engine, tool, person or date.
 *   strip   every metadata field is removed and nothing is written.
 *
 * Unset, empty or any other value means keep: an unreadable setting never
 * changes a file (fail safe). The owner's decision of 17 October 2026 is that
 * the switch stays at keep until counsel has read the provenance note.
 *
 * What "removed" covers, per format, is in docs/output-metadata.md and the
 * per-format code (metadataStills.ts, metadataMedia.ts). What it can never
 * cover: a watermark drawn into the pixels or the sound itself (an invisible
 * one such as SynthID, or a visible logo) is picture or sound, not metadata,
 * and no switch here touches it.
 *
 * The seam is prepareOutput(): lib/storage.ts calls it on every finished
 * render it stores (stills, video, audio). It is pure and synchronous; it
 * never reads a file, the network or a database.
 */

export const OUTPUT_METADATA_MODES = ["keep", "marker", "strip"] as const;
export type OutputMetadataMode = (typeof OUTPUT_METADATA_MODES)[number];
export const DEFAULT_OUTPUT_METADATA_MODE: OutputMetadataMode = "keep";

/** The switch's position. Anything but exactly marker or strip (any case, spaces trimmed) is keep. */
export function outputMetadataMode(env: Record<string, string | undefined> = process.env): OutputMetadataMode {
  const raw = env.OUTPUT_METADATA?.trim().toLowerCase();
  return raw === "marker" || raw === "strip" ? raw : DEFAULT_OUTPUT_METADATA_MODE;
}

/** IPTC NewsCodes Digital Source Type for media made by a trained model with no captured content in it. */
export const DIGITAL_SOURCE_TYPE = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";
const IPTC_EXT_NS = "http://iptc.org/std/Iptc4xmpExt/2008-02-29/";

/**
 * The marker, as a complete XMP packet: one property, Iptc4xmpExt:DigitalSourceType.
 * No toolkit attribute (x:xmptk), no instance or document id, no date: nothing
 * that could tell one file, vendor or customer from another. Unsigned: this is
 * XMP, not a C2PA manifest (a manifest needs a signing certificate, which
 * would name its signer).
 */
export const MARKER_XMP = Buffer.from(
  `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/">` +
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" xmlns:Iptc4xmpExt="${IPTC_EXT_NS}" Iptc4xmpExt:DigitalSourceType="${DIGITAL_SOURCE_TYPE}"/>` +
    `</rdf:RDF></x:xmpmeta><?xpacket end="r"?>`,
  "utf8",
);

export type OutputFormat = "jpeg" | "png" | "mp4" | "wav" | "mp3";
export type OutputKind = "image" | "video" | "audio";

/** Which container the bytes are, from their own first bytes (never the name or content type a vendor gave). */
export function sniffOutputFormat(bytes: Buffer): OutputFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "png";
  if (bytes.length >= 12 && bytes.toString("latin1", 4, 8) === "ftyp") return "mp4";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WAVE") return "wav";
  if (bytes.length >= 3 && bytes.toString("latin1", 0, 3) === "ID3") return "mp3";
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "mp3";
  return null;
}
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type PreparedOutput = {
  bytes: Buffer;
  mode: OutputMetadataMode;
  format: OutputFormat | null;
  /** keep: the switch is at keep. cleaned: the metadata was removed (and the marker written, at marker).
   *  unrecognised / unsupported / malformed: the file was stored exactly as delivered; see the log line. */
  outcome: "keep" | "cleaned" | "unrecognised" | "unsupported" | "malformed";
};

/** Removes the metadata of one file in the given position. Throws on a file it cannot rewrite safely. */
export function cleanOutputBytes(bytes: Buffer, mode: Exclude<OutputMetadataMode, "keep">, format: OutputFormat): Buffer {
  const marker = mode === "marker" ? MARKER_XMP : null;
  switch (format) {
    case "jpeg": return cleanJpeg(bytes, marker);
    case "png": return cleanPng(bytes, marker);
    case "mp4": return cleanMp4(bytes, marker);
    case "wav": return cleanWav(bytes, marker);
    case "mp3": return cleanMp3(bytes, marker);
  }
}

/**
 * THE seam. Called by lib/storage.ts with every finished render before it is
 * stored. At keep it returns the very Buffer it was given. Elsewhere it
 * returns the cleaned file, or, when the file is not one of the formats above
 * or cannot be rewritten safely, the file exactly as delivered, so a render a
 * customer paid for is never lost to this step; that case is logged
 * (storage.output_metadata, ids and sizes only) for the operator to see.
 */
export function prepareOutput(
  kind: OutputKind,
  bytes: Buffer,
  context: { id?: string; env?: Record<string, string | undefined> } = {},
): PreparedOutput {
  const mode = outputMetadataMode(context.env ?? process.env);
  if (mode === "keep") return { bytes, mode, format: null, outcome: "keep" };
  const format = sniffOutputFormat(bytes);
  let prepared: PreparedOutput;
  if (!format) prepared = { bytes, mode, format, outcome: "unrecognised" };
  else {
    try { prepared = { bytes: cleanOutputBytes(bytes, mode, format), mode, format, outcome: "cleaned" }; }
    catch (error) { prepared = { bytes, mode, format, outcome: error instanceof UnsupportedStructureError ? "unsupported" : "malformed" }; }
  }
  logOutputMetadata(kind, context.id, prepared, bytes.length);
  return prepared;
}

function logOutputMetadata(kind: OutputKind, id: string | undefined, prepared: PreparedOutput, before: number): void {
  try {
    const line = { level: prepared.outcome === "cleaned" ? "info" : "warn", event: "storage.output_metadata", kind, id, mode: prepared.mode,
      format: prepared.format, outcome: prepared.outcome, bytesBefore: before, bytesAfter: prepared.bytes.length };
    if (prepared.outcome === "cleaned") console.info(JSON.stringify(line)); else console.warn(JSON.stringify(line));
  } catch { /* a log line is not worth a save */ }
}
