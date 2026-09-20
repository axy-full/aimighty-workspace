import { STARTER_PRODUCTION, STARTER_CAST, DEFAULT_SETUP, type StarterCast, type StarterShot } from "./platformLayer";
import { DEFAULT_MODEL_ID } from "./models";
import { estimateCostUsd } from "./vendorPricing";
import { specToPhrase, type ShotSpec } from "./studio";

/**
 * The platform's demo production (brief 1.7): what a production looks like,
 * shown signed out and from every empty state, and copied into every new
 * workspace as its starter. Three shots, a few takes each, one Approved,
 * real credit numbers, a cast of two, Setup filled. Made from generic,
 * rights-clear content: the takes' pictures are the platform's own neutral
 * previews when they are published, else the fixture clip (Big Buck Bunny,
 * CC BY). No client work, no real people. No Node imports.
 */
export const DEMO_CAST: StarterCast[] = [
  STARTER_CAST,
  { name: "Mule", kind: "prop", description: "A battered cargo bicycle, orange frame, canvas panniers, a bell that does not work." },
];

export type DemoTake = {
  key: string; shotCode: string; version: number; model: string; resolution: string; duration: number;
  prompt: string; costUsd: number; approved: boolean; previewKey: string; move: string;
};

const SD25 = DEFAULT_MODEL_ID;
const price = (res: string, dur: number) => estimateCostUsd(SD25, res, "16:9", dur, 0, false, { audio: true })?.net ?? 0;
const take = (shotCode: string, version: number, resolution: string, duration: number, move: string, prompt: string, approved = false): DemoTake => ({
  key: `${shotCode}-v${version}`, shotCode, version, model: SD25, resolution, duration, prompt,
  costUsd: price(resolution, duration),
  approved, previewKey: move.includes(":") ? move : `move:${move}`, move: move.replace(/^[a-z]+:/, ""),
});

export const DEMO_TAKES: DemoTake[] = [
  take("SH010", 1, "720p", 5, "static", "A quiet street at dawn, wet from the night, the first light along the rooftops. Locked off, wide."),
  take("SH010", 2, "1080p", 5, "push", "A quiet street at dawn, wet from the night, the first light along the rooftops. The camera pushes slowly in."),
  take("SH020", 1, "720p", 5, "track", "@Mara rides @Mule down the wet street, standing on the pedals, the panniers swinging. The camera tracks alongside."),
  take("SH020", 2, "1080p", 5, "handheld", "@Mara rides @Mule down the wet street, standing on the pedals. Handheld, close behind."),
  take("SH020", 3, "1080p", 5, "technique:dollyzoom", "@Mara brakes hard as the light changes; a dolly zoom holds her while the street swells behind."),
  take("SH030", 1, "1080p", 5, "static", "A close-up on the hand-off: a parcel passed from @Mara's glove to a waiting hand in a doorway, soft light."),
  /* The one approved take sits on the LAST shot, and that is the whole
     point of where it is. A shot with an approved take is locked: the next
     render against it has to say why (lib/approval.ts). While this mark sat
     on SH010 the starter production handed every new workspace a FIRST shot
     that was already locked, so a stranger's first Generate — on the shot
     the product opens them on — came back "v2 is approved. Why render
     another?". That is rule 6 failing on the shot it is measured by: a
     paragraph before the first render. The demonstration is worth keeping,
     so it moved rather than went; on the last shot the obvious first render
     is unobstructed, and anyone who does start here sees APPROVED on the
     take before they press anything. */
  take("SH030", 2, "1080p", 5, "push", "The hand-off, closer: the parcel changes hands, the camera easing in on the two gloves.", true),
];

export type DemoShot = StarterShot & { setupFull: ShotSpec; setupLine: string };

/** The starter's shots with the platform's default Setup underneath each — every row filled. */
export function demoShots(): DemoShot[] {
  return STARTER_PRODUCTION.shots.map((s) => {
    const setupFull = { ...DEFAULT_SETUP, ...s.setup };
    return { ...s, setupFull, setupLine: specToPhrase(setupFull) };
  });
}

export const DEMO_PRODUCTION = {
  name: "Demo production",
  code: "DEMO",
  description: "What a production looks like here: three shots, a few takes each, one Approved, the credits each one cost. Made from generic footage; nothing in it is a client's or a real person.",
  cast: DEMO_CAST,
  shots: demoShots(),
  takes: DEMO_TAKES,
};

/**
 * The two places a demo take's picture can come from, and NEITHER of them is a
 * tenant original:
 *
 *   `/api/platform/previews/<key>` — one shared object in the PLATFORM asset
 *      store, outside every workspace's Blob prefix, served to all workspaces.
 *   `/fixtures/clip.mp4`          — a static file in `public/`, shipped with the
 *      build (Big Buck Bunny, CC BY). Not in storage at all.
 *
 * A real take's `stored_url` is `/api/media/<genId>`, and its bytes are at the
 * workspace's own `generations/<genId>.mp4` / `originals/video/<genId>` keys —
 * which is the only thing `lib/videoMetadata.server.ts` can open (it resolves a
 * generation by id, under the tenant prefix). So a demo take has no original for
 * the inspectors to read, and no length that can be measured from it.
 *
 * That is why `lib/starter.ts` leaves `generations.duration_s` and
 * `generations.bytes` NULL on a demo row, and why `lib/mediaSource.server.ts`
 * refuses to quote one: `params.duration` is a fixture number from `DEMO_TAKES`,
 * and per-second pricing off a fixture is a wrong bill.
 */
export const DEMO_FIXTURE_CLIP_URL = "/fixtures/clip.mp4";
export const DEMO_PREVIEW_URL_PREFIX = "/api/platform/previews/";

/** Where a demo take's picture comes from: the platform's neutral preview for its move when published, else the fixture clip. */
export function demoMediaUrl(previewKey: string, published: ReadonlySet<string>): string {
  return published.has(previewKey) ? `${DEMO_PREVIEW_URL_PREFIX}${encodeURIComponent(previewKey)}` : DEMO_FIXTURE_CLIP_URL;
}

/**
 * True when a stored URL names demo media rather than one of this workspace's
 * own stored originals — the shared platform preview or the shipped fixture
 * clip. Nothing a render path writes takes either shape.
 */
export function isDemoMediaUrl(storedUrl: string | null | undefined): boolean {
  const url = String(storedUrl ?? "");
  return url === DEMO_FIXTURE_CLIP_URL || url.startsWith(DEMO_PREVIEW_URL_PREFIX);
}

/** The production's own numbers: takes, approved, credits spent (in dollars, for the caller to price). */
export function demoTotals(takes: DemoTake[] = DEMO_TAKES): { takes: number; approved: number; usd: number } {
  return { takes: takes.length, approved: takes.filter((t) => t.approved).length, usd: Math.round(takes.reduce((a, t) => a + t.costUsd, 0) * 1000) / 1000 };
}
