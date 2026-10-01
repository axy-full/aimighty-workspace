import { DEFAULT_MODEL_ID, MARKETING_IMAGE_MODEL_ID } from "./models";
import { GENJUTSU_MODELS } from "./genjutsuTypes";
import { guessKind, unfence } from "./atomikMemoryText";

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
 * The mocked planner's library steps (lib/atomikKeySteps.ts): a brief that
 * asks for a transform or a campaign still, in a project whose library the
 * planner was shown, gets them, citing the first clip and still by handle —
 * so the plan, its prices and an approval can be watched without a vendor.
 * Anything else, or a library with nothing to work from, gets none.
 */
function mockLibrarySteps(asked: string, preamble: string): Record<string, unknown>[] {
  const offered = (id: string) => preamble.includes(`  ${id} — `);
  const clip = /^(V\d+) \| video\b/m.exec(preamble)?.[1];
  const still = /^(S\d+) \| still\b/m.exec(preamble)?.[1];
  const preset = /preset/i.test(asked) ? /^(P\d+) \| /m.exec(preamble)?.[1] : undefined;
  const out: Record<string, unknown>[] = [];
  const swap = /object swap/i.test(asked);
  const transform = GENJUTSU_MODELS[swap ? "object-swap" : "motion-transfer"];
  if (/motion transfer|object swap|transform/i.test(asked) && offered(transform) && clip && still)
    out.push({ kind: "video", title: swap ? "Mocked swap" : "Mocked motion transfer", prompt: swap ? "Swap the bottle for the product in the reference still." : "Carry the clip's movement onto the figure in the reference still.",
      model: transform, source: clip, references: [still], resolution: "720p" });
  if (/marketing|campaign/i.test(asked) && offered(MARKETING_IMAGE_MODEL_ID))
    out.push({ kind: "image", title: "Mocked campaign still", prompt: "The product on a clean studio sweep, soft key light from the left.",
      model: MARKETING_IMAGE_MODEL_ID, references: still ? [still] : [], quality: "high", ratio: "1:1", resolution: "2k", ...(preset && still ? { preset } : {}),
      /* A brief that names a 2.5 build gets it, at extra-high quality. */
      ...(/sunburst/i.test(asked) ? { build: "sunburst", quality: "xhigh" } : /flare|2\.5/i.test(asked) ? { build: "flare", quality: "xhigh" } : {}) });
  return out;
}

/**
 * The mocked reader's proposals for Memory (lib/atomikMemoryRead.ts): one
 * entry per line of the fenced text, sorted by what it talks about. Like a
 * careless model, it proposes every line — amounts included — so the server's
 * own amounts-only filter is what keeps them out.
 */
function mockMemoryEntries(asked: string): { kind: string; text: string }[] {
  return unfence(asked).split(/\n+/)
    .map((line) => line.replace(/^(?:[-*•]+|\d{1,3}[.)])\s+/, "").replace(/\*\*|__|`/g, "").trim())
    .filter((line) => line.length >= 3 && !/^#{1,6}\s/.test(line) && !/:$/.test(line))
    .slice(0, 30)
    .map((text) => ({ kind: guessKind(text), text }));
}

/**
 * A canned chat completion, shaped like the gateway's, for the things the
 * app asks a text model for.
 */
export function mockCompletion(kind: "prompt" | "turn" | "idea" | "scene" | "shots" | "memory", requestBody: string): { ok: boolean; status: number; text: string } {
  let lastUser = "";
  let asked = "", preamble = "";
  try {
    const j = JSON.parse(requestBody) as { messages?: { role: string; content: string }[] };
    lastUser = [...(j.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "";
    /* A turn's last message may carry pictures beside its words: only the words are read. */
    const words = (content: unknown) => typeof content === "string" ? content
      : Array.isArray(content) ? content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join(" ") : "";
    asked = words(lastUser);
    preamble = words((j.messages ?? []).find((m) => m.role === "user" && words(m.content).startsWith("ENGINES YOU MAY CHOOSE"))?.content);
  } catch { /* an unreadable body still gets a reply */ }
  const library = kind === "turn" ? mockLibrarySteps(asked, preamble) : [];
  const content =
    kind === "turn" && library.length ? JSON.stringify({
      title: "Mocked library steps",
      say: "Mocked: library steps from this project's own media, each priced before it is shown.",
      activity: ["read the brief", "read the library"],
      propose: library,
    })
    : kind === "turn" ? JSON.stringify({
      title: "Mocked production",
      say: "Mocked: one shot, so the pipeline can be watched end to end without a vendor.",
      activity: ["read the brief", "chose one engine"],
      /* A model told what it was shown says so on the step it proposes; the
         mock answers the same way, so the whole path can be watched. */
      propose: [{ kind: "video", title: "Mocked shot", prompt: "A mocked shot, held still for five seconds.", model: DEFAULT_MODEL_ID, seconds: 5, ratio: "16:9", resolution: "1080p", attachments: /ATTACHED:/.test(requestBody) }],
    })
    : kind === "memory" ? JSON.stringify({ entries: mockMemoryEntries(asked) })
    : kind === "idea" ? JSON.stringify({ logline: `Mocked logline for: ${lastUser.replace(/^NOTE:\s*/i, "").slice(0, 120)}`, tone: ["mocked", "quiet", "30s"] })
    : kind === "scene" ? JSON.stringify({ title: "Mocked scene", secs: 6, prose: "Mocked: the scene, rewritten — the same beat, one clear action, the cast where they were." })
    : kind === "shots" ? JSON.stringify({ shots: [
        { title: "Mocked establishing", description: "The street at dawn, wet from the night, the first light along the rooftops.", planned: 5, setup: { shot: "evs", time: "dawn", move: "static" }, cast: [], engine: "seedance", why: "standard video" },
        { title: "Mocked splash", description: "The bicycle cuts through a flooded gutter, water fanning off the front wheel.", planned: 4, setup: { shot: "cu", move: "track" }, cast: [], engine: "kling", why: "water: water, cloth and physics go to Kling 3.0" },
      ] })
    : lastUser.slice(0, 2000) || "A mocked prompt.";
  return {
    ok: true, status: 200,
    text: JSON.stringify({ choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 500, completion_tokens: 120, cost: 0.002 } }),
  };
}
