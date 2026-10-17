# Output metadata switch

One server setting, `OUTPUT_METADATA`, decides what happens to the metadata embedded in a finished render before it is stored. Code: `lib/storage/outputMetadata.ts` (the switch and the seam), `lib/storage/metadataStills.ts` (JPEG, PNG), `lib/storage/metadataMedia.ts` (MP4/MOV, WAV, MP3). Tests: `tests/unit/outputMetadata.spec.ts`.

**Owner's decision, 17 October 2026: the switch stays at `keep` until counsel has read the provenance note. No vendor metadata is removed from any output until then.** Setting it is a Coolify environment variable on the app; nothing in the interface shows or changes it.

## Positions

| Value | What is stored |
|---|---|
| `keep` (default) | The delivered file, byte for byte, exactly as before the switch existed. |
| `marker` | The file with every metadata field removed and one marker written: an XMP packet holding only `Iptc4xmpExt:DigitalSourceType = http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia`. |
| `strip` | The file with every metadata field removed and nothing written. |

Unset, empty, or any other value is `keep` (fail safe). Matching ignores case and surrounding spaces.

**The marker.** The IPTC Digital Source Type is the vocabulary C2PA itself uses for its `digitalSourceType`, and the XMP property is the one the IPTC Photo Metadata Standard defines for it. `trainedAlgorithmicMedia` is IPTC's term for media made by a trained model with no captured content in it. The packet has no toolkit attribute, no document or instance id and no date, so it names no vendor, engine, tool, person or time, and two files with the marker carry the same packet. It is plain XMP and is not signed. A C2PA manifest needs a signing certificate, which would name whoever signed it. Where it goes, per the XMP specification Part 3:

| Format | Where the marker goes |
|---|---|
| JPEG | An APP1 segment `http://ns.adobe.com/xap/1.0/`, right after SOI |
| PNG | An uncompressed `iTXt` chunk `XML:com.adobe.xmp`, right after IHDR |
| MP4/MOV | A top-level `uuid` box `BE7ACFCB-97A9-42E8-9C71-999491E3AFAC`, right after `ftyp` |
| WAV | A `_PMX` chunk, right after `fmt ` |
| MP3 | A leading ID3v2.3 tag with one `PRIV` frame owned by `XMP` |

## What survives `strip` (and `marker`, plus the marker)

The coded picture and sound are never decoded or re-encoded. They are copied byte for byte.

- **JPEG.** Kept: the frame, quantisation and Huffman tables, scans, restart markers, the ICC profile (APP2) and Adobe's colour-transform segment (APP14). Removed: every other APPn (JFIF and its thumbnail, EXIF, XMP and extended XMP, Photoshop/IPTC, MPF and any second image or gain map, APP11 JUMBF where C2PA lives, maker data), every comment, and anything after the end of the image.
- **PNG.** Kept: IHDR, PLTE, IDAT, IEND, any other critical chunk, and the chunks that change how the picture is drawn (tRNS, gAMA, cHRM, sRGB, iCCP, cICP, mDCV, cLLI, sBIT, and the APNG chunks acTL, fcTL, fdAT). Removed: everything else, including tEXt, zTXt, iTXt (XMP), eXIf, tIME, pHYs, bKGD, the C2PA `caBX` chunk and private chunks, and anything after IEND.
- **MP4/MOV.** Kept: `ftyp`, every `mdat`, and in `moov` the boxes needed to play (mvhd, trak, iods, pssh; in each track tkhd, tref, trgr, edts, tapt, mdia and its sample tables and codec configuration). Removed: every other top-level box (C2PA's and XMP's `uuid` boxes, top-level `meta`, `free`/`skip`/`wide`), and `udta`, `meta`, `uuid` and padding at every level inside `moov` (titles, artist, comments, encoder name, dates, places, iTunes-style tags). Timed-metadata tracks are dropped, and their samples in `mdat` are overwritten with zeros. Neutralised in place: creation and modification times (set to zero), handler names (emptied), and each sample description's compressor name and QuickTime vendor fields (set to zero). The chunk offsets are rewritten for the new layout. Checked on a real H.264 + MP3 file, with moov first and with moov last: ffprobe reads it, and every packet's timing, flags and MD5 match the original.
- **WAV.** Kept: `fmt `, `fact`, `data`. Removed: every other chunk (LIST/INFO, id3, bext, iXML, axml, `_PMX`, cue points and labels, smpl, inst, acid, cart, umid, padding).
- **MP3.** Kept: the MPEG frames. Removed: leading ID3v2 tags (with their pictures, comments, encoder and C2PA `GEOB` frames), and trailing ID3v1/TAG+, APEv2, appended ID3v2.4 and Lyrics3v2 tags.

**Colour profiles are kept on purpose.** Removing one changes how the colours look. `exiftool -all=` removes them too, so if the owner wants them gone, that is a one-line change.

## What no position can remove

- **A watermark inside the picture or the sound.** SynthID, or a visible logo or "draft" mark, is part of the pixels or samples, not metadata.
- **An encoder's note inside the coded stream.** For example, the x264 version and settings in an H.264 SEI message, or the encoder name in an MP3's first (Xing/LAME) frame. `ffmpeg -map_metadata -1 -c copy` keeps those as well.
- **A file it cannot rewrite safely.** This covers formats other than the five above (WebP, GIF, RF64, Ogg and others), fragmented MP4, and damaged files. They are stored exactly as delivered, so a render someone paid for is never lost at this step, and a `storage.output_metadata` warning line (ids and sizes only) is logged.

## The seam

`prepareOutput(kind, bytes)` is called by `lib/storage.ts` on every finished render it stores. The calls are in `storeImageBytes`, `storeAudioBytes`, `storeVideoBytes` (the API-key originals collected for Higgsfield video), and `storeVideo` (its mock-fixture path and its streamed provider path). It is pure and synchronous. At `keep` it returns the very Buffer it was given, and the streamed save passes the provider's stream straight through, as before (tests/unit/storage-stream-memory.spec.ts). At `marker` or `strip`, a streamed video is gathered in memory once (still under `MAX_PROVIDER_VIDEO_BYTES`), rewritten, then uploaded. That is up to the cap, 1 GiB by default, per save in flight.

The rewrite is deterministic and idempotent, so a retried save stores the same bytes. Changing the switch while a save is between attempts can leave that one save refusing to overwrite an immutable original it already wrote. To avoid that, change the switch while no renders are in flight.

**Not passed through the seam, because they are not finished renders:**

- a person's own uploads;
- review stills grabbed from a take (`app/api/workbench/atomik/frames`);
- the platform camera-bank previews (`storePlatformBytes`);
- identity training sets;
- consent recordings;
- the retired connected-account originals (`lib/higgsfield-consumer`, `storeOriginalBytes`), where nothing new starts;
- exports from the export worker (`remotion/`), which renders our own templates. If an export carries a render's metadata into its file, the worker's ffmpeg (shipped inside `@remotion/compositor`) is the place to add `-map_metadata -1` when that work lands.

**Already true at `keep`, today.** Stills that the app transcodes to PNG with sharp lose their EXIF, XMP and C2PA data in that transcode, because sharp writes no metadata unless asked to. That happens before this seam and is unchanged by it. It covers every still in `finishStill` (`lib/renderWork.ts`) except the Topaz upscale, JPEG stills from the identity engine, and the extra stills of a batch. The Topaz image upscale, a PNG from the identity engine, every video and every voice line are stored with their metadata as delivered.
