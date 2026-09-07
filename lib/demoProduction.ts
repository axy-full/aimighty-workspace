import { STARTER_PRODUCTION, STARTER_CAST, DEFAULT_SETUP, type StarterCast, type StarterShot } from "./platformLayer";
import { estimateCostUsd, DEFAULT_MODEL_ID } from "./models";
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
  key: `${shotCode}-v${version}`, shotCode, version, model: SD25, resolution, duration, prompt, costUsd: price(resolution, duration),
  approved, previewKey: move.includes(":") ? move : `move:${move}`, move: move.replace(/^[a-z]+:/, ""),
});

export const DEMO_TAKES: DemoTake[] = [
  take("SH010", 1, "720p", 5, "static", "A quiet street at dawn, wet from the night, the first light along the rooftops. Locked off, wide."),
  take("SH010", 2, "1080p", 5, "push", "A quiet street at dawn, wet from the night, the first light along the rooftops. The camera pushes slowly in.", true),
  take("SH020", 1, "720p", 5, "track", "@Mara rides @Mule down the wet street, standing on the pedals, the panniers swinging. The camera tracks alongside."),
  take("SH020", 2, "1080p", 5, "handheld", "@Mara rides @Mule down the wet street, standing on the pedals. Handheld, close behind."),
  take("SH020", 3, "1080p", 5, "technique:dollyzoom", "@Mara brakes hard as the light changes; a dolly zoom holds her while the street swells behind."),
  take("SH030", 1, "1080p", 5, "static", "A close-up on the hand-off: a parcel passed from @Mara's glove to a waiting hand in a doorway, soft light."),
  take("SH030", 2, "1080p", 5, "push", "The hand-off, closer: the parcel changes hands, the camera easing in on the two gloves."),
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

/** Where a demo take's picture comes from: the platform's neutral preview for its move when published, else the fixture clip. */
export function demoMediaUrl(previewKey: string, published: ReadonlySet<string>): string {
  return published.has(previewKey) ? `/api/platform/previews/${encodeURIComponent(previewKey)}` : "/fixtures/clip.mp4";
}

/** The production's own numbers: takes, approved, credits spent (in dollars, for the caller to price). */
export function demoTotals(takes: DemoTake[] = DEMO_TAKES): { takes: number; approved: number; usd: number } {
  return { takes: takes.length, approved: takes.filter((t) => t.approved).length, usd: Math.round(takes.reduce((a, t) => a + t.costUsd, 0) * 1000) / 1000 };
}
