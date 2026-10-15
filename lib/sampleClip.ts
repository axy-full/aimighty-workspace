import { DEMO_FIXTURE_CLIP_URL } from "./demoProduction";

/**
 * The credit the starter production's sample clip carries (owner, 15 Oct 22:00: "add the Big Buck Bunny credit (CC BY 3.0, Blender Foundation) to the starter
 * production"). `public/fixtures/clip.mp4` is Big Buck Bunny, (c) 2008 Blender Foundation, CC BY 3.0 (public/fixtures/README.md). It reaches a workspace only as the starter
 * production's fallback picture, when the platform's neutral previews are not published (lib/starter.ts › demoMediaUrl). Wherever that clip shows or leaves in a file, the
 * credit goes with it: one short line, the title linking to the source and "CC BY 3.0" to the licence.
 */
export const SAMPLE_CLIP_URL = DEMO_FIXTURE_CLIP_URL;
export const SAMPLE_CLIP_CREDIT = {
  title: "Big Buck Bunny",
  line: "Big Buck Bunny © Blender Foundation, CC BY 3.0",
  licence: "CC BY 3.0",
  licenceUrl: "https://creativecommons.org/licenses/by/3.0/",
  sourceUrl: "https://peach.blender.org/",
} as const;

/** The credit as plain text for a file's own metadata, a CSV or a credits file: the line and both links. */
export const SAMPLE_CLIP_CREDIT_TEXT = `${SAMPLE_CLIP_CREDIT.line} (${SAMPLE_CLIP_CREDIT.licenceUrl}; source ${SAMPLE_CLIP_CREDIT.sourceUrl})`;

/** Whether a stored URL is the starter's sample clip, the fallback picture (and so carries the credit). Previews the platform publishes are neutral and carry none. */
export const isSampleClipUrl = (storedUrl: string | null | undefined): boolean => String(storedUrl ?? "") === SAMPLE_CLIP_URL;

/** The notice an export carries beside the takes that hold the clip: the line, both links, and which takes. */
export function sampleClipNotice(takeIds: readonly string[]) {
  return { notice: SAMPLE_CLIP_CREDIT.line, licence: SAMPLE_CLIP_CREDIT.licence, licenceUrl: SAMPLE_CLIP_CREDIT.licenceUrl, sourceUrl: SAMPLE_CLIP_CREDIT.sourceUrl, takes: [...takeIds] };
}

/** The text of a CREDITS.txt for a package: one line and the two links. */
export const SAMPLE_CLIP_CREDITS_FILE = `${SAMPLE_CLIP_CREDIT.line}\r\nLicence: ${SAMPLE_CLIP_CREDIT.licenceUrl}\r\nSource: ${SAMPLE_CLIP_CREDIT.sourceUrl}\r\n`;

/**
 * Whether an asset is the sample clip: its draft says so (a starter made since the credit shipped), or the server's list of takes that hold the clip does
 * (`sampleTakes`, from GET /api/sample-clip), which also credits a starter draft made before it did.
 */
export const isSampleClipAsset = (asset: { sampleClip?: true; generationId?: string | null }, sampleTakes?: ReadonlySet<string> | null): boolean =>
  Boolean(asset.sampleClip) || Boolean(asset.generationId && sampleTakes?.has(asset.generationId));

/** A movie export's own metadata comment: its fixed words, and the credit when a clip in the cut is the starter's sample clip. */
export const MOVIE_COMMENT = "Particl timeline export; SDR canvas render; straight cuts.";
export function movieComment(clips: readonly { asset: { sampleClip?: true; generationId?: string | null } }[], sampleTakes?: ReadonlySet<string> | null): string {
  return clips.some((clip) => isSampleClipAsset(clip.asset, sampleTakes)) ? `${MOVIE_COMMENT} ${SAMPLE_CLIP_CREDIT_TEXT}` : MOVIE_COMMENT;
}
