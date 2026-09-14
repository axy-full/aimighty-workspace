import { DEFAULT_MODEL_ID } from "./models";

/**
 * Mocked engines, for development and tests. No Node imports here: the
 * price on a button reaches this module through lib/providers.
 *
 * ENGINE_MOCK=1 makes every adapter answer from a fixture instead of a
 * vendor: a video job "renders" Big Buck Bunny, a still a gradient, a
 * sound a sample tone, a text call a canned reply. Jobs still go through
 * the same rows, polls, storage and metering as the real thing — that is
 * the point — but no vendor is called and nobody's money moves.
 *
 * The rule behind it (docs/particl-sow.md §3, rule 1): development never
 * bills a customer workspace. A real engine call is a deliberate act in a
 * test workspace with the cost said out loud first.
 */
export const engineMock = (): boolean => process.env.ENGINE_MOCK === "1";

/** A fixture URL: the adapters hand these out; storage reads them from disk. */
export const FIXTURE = "fixture:";
export type FixtureName = "clip.mp4" | "astra-clip.mp4" | "tone.mp3" | "still.png";

export const isFixtureUrl = (url: string): boolean => url.startsWith(FIXTURE);
export const fixtureUrl = (name: FixtureName): string => `${FIXTURE}${name}`;

/* fixtureBytes and fetchBytes live in ./mockFs — they read disk, and this
   module is also bundled for the browser. */

/** A mock job id carries its birth time — and, when given, a tag of what was
 *  asked for (no underscores in it), so the mock can charge for THAT and not
 *  for some fixed clip; the job is "done" a few seconds later. */
export const mockJobId = (prefix: string, tag?: string): string => `mock_${prefix}_${tag ? `${tag.replace(/_/g, "-")}_` : ""}${Date.now()}`;
/** The tag a mock id was given, or null for an id without one. */
export function mockTag(id: string): string | null {
  const parts = id.split("_");
  return parts.length >= 4 ? parts.slice(2, -1).join("_") : null;
}
export const isMockJob = (id: string): boolean => id.startsWith("mock_");
export function mockDone(id: string, delayMs = 3000): boolean {
  const ts = Number(id.split("_").pop());
  return !Number.isFinite(ts) || Date.now() - ts >= delayMs;
}
export const mockStartedAt = (id: string): number => Number(id.split("_").pop()) || Date.now();

/**
 * A canned chat completion, shaped like the gateway's, for the three
 * things the app asks a text model for.
 */
export function mockCompletion(kind: "prompt" | "turn" | "idea" | "scene" | "shots", requestBody: string): { ok: boolean; status: number; text: string } {
  let lastUser = "";
  try {
    const j = JSON.parse(requestBody) as { messages?: { role: string; content: string }[] };
    lastUser = [...(j.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "";
  } catch { /* an unreadable body still gets a reply */ }
  const content =
    kind === "turn" ? JSON.stringify({
      title: "Mocked production",
      say: "Mocked: one shot, so the pipeline can be watched end to end without a vendor.",
      activity: ["read the brief", "chose one engine"],
      /* A model told what it was shown says so on the step it proposes; the
         mock answers the same way, so the whole path can be watched. */
      propose: [{ kind: "video", title: "Mocked shot", prompt: "A mocked shot, held still for five seconds.", model: DEFAULT_MODEL_ID, seconds: 5, ratio: "16:9", resolution: "1080p", attachments: /ATTACHED:/.test(requestBody) }],
    })
    : kind === "idea" ? JSON.stringify({ logline: `Mocked logline for: ${lastUser.replace(/^NOTE:\s*/i, "").slice(0, 120)}`, tone: ["mocked", "quiet", "30s"] })
    : kind === "scene" ? JSON.stringify({ title: "Mocked scene", secs: 6, prose: "Mocked: the scene, rewritten — the same beat, one clear action, the cast where they were." })
    : kind === "shots" ? JSON.stringify({ shots: [
        { title: "Mocked establishing", description: "The street at dawn, wet from the night, the first light along the rooftops.", planned: 5, setup: { shot: "evs", time: "dawn", move: "static" }, cast: [], engine: "seedance", why: "standard video" },
        { title: "Mocked splash", description: "The bicycle cuts through a flooded gutter, water fanning off the front wheel.", planned: 4, setup: { shot: "cu", move: "track" }, cast: [], engine: "kling", why: "water: water, cloth and physics go to Kling" },
      ] })
    : lastUser.slice(0, 2000) || "A mocked prompt.";
  return {
    ok: true, status: 200,
    text: JSON.stringify({ choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 500, completion_tokens: 120, cost: 0.002 } }),
  };
}
