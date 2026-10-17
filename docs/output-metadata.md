# Output metadata switch

One server setting, `OUTPUT_METADATA`, decides what happens to the metadata embedded in a finished render before it is stored. Code: `lib/storage/outputMetadata.ts` (the switch and the seam), `lib/storage/metadataStills.ts` (JPEG, PNG), `lib/storage/metadataMedia.ts` (MP4/MOV, WAV, MP3). Tests: `tests/unit/outputMetadata.spec.ts` and `tests/unit/outputMetadataCollect.spec.ts`.

**Owner's decision, 17 October 2026: the switch stays at `keep` until counsel has read the provenance note. No vendor metadata is removed from any output until then.** Setting it is a Coolify environment variable on the app; nothing in the interface shows or changes it.

## Positions

| Value | What is stored |
|---|---|
| `keep` (default) | The delivered file, byte for byte, exactly as before the switch existed. |
| `marker` | The file with every metadata field removed and one marker written: an XMP packet holding only `Iptc4xmpExt:DigitalSourceType = http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia`. |
| `strip` | The file with every metadata field removed and nothing written. |

Unset, empty, or any other value is `keep` (fail safe). Matching ignores case and surrounding spaces.

A second setting, `OUTPUT_METADATA_MAX_BYTES` (default 256 MiB), is the largest file the seam rewrites. A larger file is stored as delivered (outcome `too_large`).

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

- **JPEG.** Kept: the frame, quantisation and Huffman tables, scans, restart markers, the ICC profile (APP2) and Adobe's colour-transform segment (APP14). Removed: every other APPn (JFIF and its thumbnail, EXIF, XMP and extended XMP, Photoshop/IPTC, MPF and any second image or gain map, APP11 JUMBF where C2PA lives, maker data), every comment, and anything after the end of the image. Two removals change how a file can look:
  - EXIF Orientation goes with EXIF, so a picture that relied on it shows unrotated. Engines deliver their pictures upright.
  - An Ultra HDR file loses its gain map and shows as its standard-range base picture.
- **PNG.** Kept: IHDR, PLTE, IDAT, IEND, any other critical chunk, and the chunks that change how the picture is drawn (tRNS, gAMA, cHRM, sRGB, iCCP, cICP, mDCV, cLLI, sBIT, and the APNG chunks acTL, fcTL, fdAT). Removed: everything else, including tEXt, zTXt, iTXt (XMP), eXIf, tIME, pHYs, bKGD, the C2PA `caBX` chunk and private chunks, and anything after IEND.
- **MP4/MOV.** Kept: `ftyp`, every `mdat`, and in `moov` the boxes needed to play (mvhd, trak, iods, pssh; in each track tkhd, tref, trgr, edts, tapt, mdia and its sample tables and codec configuration). Removed: every other top-level box (C2PA's and XMP's `uuid` boxes, top-level `meta`, `free`/`skip`/`wide`), and `udta`, `meta`, `uuid` and padding at every level inside `moov` (titles, artist, comments, encoder name, dates, places, iTunes-style tags). Timed-metadata tracks are dropped, and their samples in `mdat` are overwritten with zeros. Neutralised in place: creation and modification times (set to zero), handler names (emptied), and each sample description's compressor name and QuickTime vendor fields (set to zero). The chunk offsets are rewritten for the new layout.

  Every rewrite is read back before it is kept. Each kept track's every chunk, found through the rewritten tables, must hold exactly the bytes it held in the delivered file. If it doesn't, the rewrite is thrown away and the file is stored as delivered (outcome `unverified`). A zeroed range that would touch a kept track's samples or an mdat header is refused before anything is written.

  Checked by hand on a real H.264 + MP3 file, with moov first and with moov last: ffprobe reads it, and every packet's timing, flags and MD5 match the original.

  Text that can remain in an MP4: the samples of a text, subtitle or chapter track (handler `text`, `sbtl` or `subt`, such as tx3g subtitles), kept as tracks because they are content, and a timecode track's (`tmcd`) reel name inside its sample description.
- **WAV.** Kept: `fmt `, `fact`, `data`. Removed: every other chunk (LIST/INFO, id3, bext, iXML, axml, `_PMX`, cue points and labels, smpl, inst, acid, cart, umid, padding).
- **MP3.** Kept: the MPEG frames. Removed: leading ID3v2 tags (with their pictures, comments, encoder and C2PA `GEOB` frames), and trailing ID3v1/TAG+, APEv2, appended ID3v2.4 and Lyrics3v2 tags.

**Colour profiles are kept on purpose.** Removing one changes how the colours look. An ICC profile has its own description and copyright text (`desc`, `cprt`), which can carry a vendor's or a tool's name, and that text survives with the profile. `exiftool -all=` removes the profiles too, so if the owner wants them gone, that is a one-line change.

## What no position can remove

- **A watermark inside the picture or the sound.** SynthID, or a visible logo or "draft" mark, is part of the pixels or samples, not metadata.
- **An encoder's note inside the coded stream.** For example, the x264 version and settings in an H.264 SEI message, or the encoder name in an MP3's first (Xing/LAME) frame. `ffmpeg -map_metadata -1 -c copy` keeps those as well.
- **A file it cannot rewrite safely.** This covers:
  - formats other than the five above (WebP, GIF, RF64, Ogg and others);
  - fragmented MP4;
  - damaged files;
  - a rewrite that does not read back the same;
  - a file over `OUTPUT_METADATA_MAX_BYTES`;
  - a file with more than 100,000 boxes, segments or chunks, or more than 100,000 chunks in one MP4 track.

  These are stored exactly as delivered, so a render someone paid for is never lost at this step. A `storage.output_metadata` warning line (ids and sizes only, `alert: true`) is logged. **Once counsel requires `marker` or `strip`, every one of these lines is a compliance miss.** The operator's log alerting should page on `event=storage.output_metadata alert=true`.

## The seam

`prepareOutput(kind, bytes)` is called by `lib/storage.ts` on every finished render it stores. The calls are in `storeImageBytes`, `storeAudioBytes`, `storeVideoBytes` (the API-key originals collected for Higgsfield video), and `storeVideo` (its mock-fixture path and its streamed provider path). It is pure and synchronous. At `keep` it returns the very Buffer it was given, and the streamed save passes the provider's stream straight through, as before (tests/unit/storage-stream-memory.spec.ts).

At `marker` or `strip`, a streamed video is gathered in memory, rewritten, then uploaded in 8 MiB slices. Only one file is gathered at a time in each process (`rewriteSlot`); other saves wait for the slot, under their own timeout. So the memory a rewrite holds is one file, at most `OUTPUT_METADATA_MAX_BYTES`, plus its rewrite. If a file's declared length is over that ceiling, it streams through as delivered. If the count passes the ceiling while gathering, what was gathered is sent on and the rest streams through as delivered. Both cases log `too_large`.

The rewrite is deterministic and idempotent, so a retried save stores the same bytes.

**The API-key video collection** (`lib/genjutsuVideo.ts`) runs the seam once, itself, before it takes the original's receipt. The receipt (sha256 and length), the storage-quota figure and the stored file are then the same bytes. A collection whose final write was lost settles from the stored file on the next poll (tests/unit/outputMetadataCollect.spec.ts). `storeVideoBytes` runs the seam again over those bytes, which changes nothing.

Two edges remain:
- Changing the switch while a collection is between attempts leaves its receipt describing the other position's bytes. That one take then refuses to settle until someone looks at it. Change the switch while no renders are in flight.
- The marker adds about 0.5 KB. A delivered original within 0.5 KB of the 100 MiB limit on immutable originals would exceed it after the marker and fail to store.

**Not passed through the seam, because they are not finished renders:**

- a person's own uploads;
- review stills grabbed from a take (`app/api/workbench/atomik/frames`);
- the platform camera-bank previews (`storePlatformBytes`);
- identity training sets;
- consent recordings;
- the retired connected-account originals (`lib/higgsfield-consumer`, `storeOriginalBytes`), where nothing new starts;
- exports from the export worker (`remotion/`), which renders our own templates. If an export carries a render's metadata into its file, the worker's ffmpeg (shipped inside `@remotion/compositor`) is the place to add `-map_metadata -1` when that work lands.

**Already true at `keep`, today.** Stills that the app transcodes to PNG with sharp lose their EXIF, XMP and C2PA data in that transcode, because sharp writes no metadata unless asked to. That happens before this seam and is unchanged by it. It covers every still in `finishStill` (`lib/renderWork.ts`) except the Topaz upscale, plus JPEG stills from the identity engine (`finishRender` in `lib/identities.ts`) and the extra stills of a batch (`fileSoulBatch` in `lib/renderWork.ts`). The Topaz image upscale, a PNG from the identity engine, every video and every voice line are stored with their metadata as delivered.
