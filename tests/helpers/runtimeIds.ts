/**
 * Model and engine ids a spec needs only as "one of this kind", read from the code and the checked-in catalogue at run time, so no spec
 * outside the catalogue tests writes a model id down (owner, 23 Oct 2026). The slots themselves are tests/helpers/thinkingSlots.ts's.
 */
import { ASTRA_BLENDER_MODEL } from "../../lib/astra-blender/scene";
import { elevenlabs } from "../../lib/engines/elevenlabs";
import { DEFAULT_MODEL_ID, MARKETING_IMAGE_MODEL_ID, NANO_BANANA_2_ID, NANO_BANANA_PRO_ID } from "../../lib/models";
import { snapshotModels } from "../../lib/catalog";
import { CLAUDE_MODEL_IDS } from "../../lib/atomikModelPolicy";

/** The default video engine, and two still engines (by their engine ids). */
export const VIDEO_ENGINE = DEFAULT_MODEL_ID;
export const STILL_ENGINE = NANO_BANANA_PRO_ID, FAST_STILL_ENGINE = NANO_BANANA_2_ID;
export const MARKETING_STILL_ENGINE = MARKETING_IMAGE_MODEL_ID;
/** The sound engine (voice, sound effects and music), by its adapter id. */
export const AUDIO_ENGINE = elevenlabs.id;

/** The 3D blocking engine's OpenAI text model (catalogue id), and the same id as OpenAI spells it. */
export const ASTRA = ASTRA_BLENDER_MODEL;
export const ASTRA_VENDOR_ID = ASTRA_BLENDER_MODEL.slice("openai/".length);

const snapshot = () => snapshotModels();
const optionsOf = (id: string) => snapshot().find((m) => m.id === id)?.reasoningOptions ?? [];
/** The first id that fits, or a clear failure naming what the checked-in catalogue no longer has (never a silent undefined). */
function first(ids: readonly string[], fits: (id: string) => boolean, what: string): string {
  const id = ids.find(fits);
  if (!id) throw new Error(`tests/helpers/runtimeIds.ts: the checked-in catalogue (lib/modelCatalog.json) has no ${what}.`);
  return id;
}

/** A verified Claude id whose catalogue entry thinks on a token budget (the older generation), and one that takes a named effort. */
export const BUDGET_CLAUDE = first(CLAUDE_MODEL_IDS, (id) => optionsOf(id).some((o) => o.type === "budget_tokens"), "verified Claude entry that thinks on a token budget");
export const EFFORT_CLAUDE = first(CLAUDE_MODEL_IDS, (id) => optionsOf(id).some((o) => o.type === "effort") && !optionsOf(id).some((o) => o.type === "budget_tokens"),
  "verified Claude entry that takes a named effort and no token budget");

/**
 * Catalogue ids that are not text models at all (stills and other media), for "not a text model" checks: chosen by the catalogue's
 * own type, not by the verified list, so a check that reads the verified list can fail on them.
 */
export const NOT_TEXT_IDS: readonly string[] = snapshot().filter((m) => m.type !== "language").map((m) => m.id);
