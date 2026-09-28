/**
 * What Particl reaches through the owner's connected account, as rows with a
 * live status (Atomik › Tools & connections).
 *
 * One row per capability that has a place in the Suites product today. Each
 * names the tools Particl's own code calls for it — the same fixed names the
 * toolset guard checks before any spend — grouped as "every group must be
 * advertised, any tool in a group will do". The live check is the
 * connection's own `tools/list` (free, read-only): a row is available when
 * every group has an advertised tool. A row whose feature the platform has
 * switched off (video analysis) reads as off whatever the account offers.
 *
 * Tools only: a row that runs on one catalogue model (Viral on Genjutsu, say)
 * is checked for the generation tool, and its page checks the model when it
 * opens. Only row ids and flags leave the server — the account's tool names,
 * descriptions and schemas never reach the browser, and nothing from the
 * account's own library (characters, media, generations) is read.
 *
 * Pure (no network, no database) so the browser and the server share it.
 * tests/unit/toolsConnections.spec.ts keeps the names in step with the
 * constants the workflows actually call.
 */
export type ConnectedReachId =
  | "models" | "image" | "video" | "audio" | "files" | "follow"
  | "characters" | "elements" | "voice" | "dub" | "reframe" | "analysis"
  | "templates" | "motion";

export type ConnectedReach = {
  id: ConnectedReachId;
  label: string;
  line: string;
  /** Every group must be advertised; any one tool in a group satisfies it. */
  needs: readonly (readonly string[])[];
};

const STATUS = ["job_status", "jobs_wait", "job_display"] as const;

export const CONNECTED_REACH: readonly ConnectedReach[] = Object.freeze([
  { id: "models", label: "Connected models", line: "The account’s catalogue, in Gen’s model picker", needs: [["models_explore"]] },
  { id: "image", label: "Images", line: "Stills on the account’s image models", needs: [["generate_image"]] },
  { id: "video", label: "Video", line: "Takes on the account’s video models", needs: [["generate_video"]] },
  { id: "audio", label: "Sound", line: "Speech, music and effects on the account’s audio models", needs: [["generate_audio"]] },
  { id: "files", label: "Your files as references", line: "Pictures and clips from the project travel with the take", needs: [["media_import_url"]] },
  { id: "follow", label: "Takes that finish while you are away", line: "Followed until the file is in Takes", needs: [STATUS] },
  { id: "characters", label: "Soul ID characters", line: "Built in Cast from the project’s own pictures", needs: [["show_characters"], ["media_import_url"]] },
  { id: "elements", label: "Reference elements", line: "Props, places and looks saved in Cast for reuse", needs: [["show_reference_elements"], ["media_import_url"]] },
  { id: "voice", label: "Change voice", line: "Re-voice a project video, timing kept", needs: [["voice_change"], STATUS] },
  { id: "dub", label: "Dub", line: "Translate a project video’s speech and re-voice it", needs: [["dubbing"], STATUS] },
  { id: "reframe", label: "Social cuts", line: "9:16 and 1:1 cuts from the same master", needs: [["reframe"], STATUS] },
  { id: "analysis", label: "Analyse video", line: "Hook and retention report on a finished video", needs: [["video_analysis_create"], ["video_analysis_status"]] },
  { id: "templates", label: "Ad templates", line: "Branded image ads from the account’s templates", needs: [["marketing_studio_v2_presets"], ["marketing_studio_v2_costs"], ["marketing_studio_v2_create"], ["marketing_studio_v2_status"]] },
  { id: "motion", label: "Motion transfer & object swap", line: "Recast motion you own, or swap one element", needs: [["generate_video"]] },
] as const satisfies readonly ConnectedReach[]);

/** `off`: the platform has this feature switched off, whatever the account offers. */
export type ReachCheck = { id: ConnectedReachId; available: boolean; off?: true };

/** Every connected row against the advertised tool names of one connection. */
export function reachFromTools(names: Iterable<string>, options: { off?: readonly ConnectedReachId[] } = {}): ReachCheck[] {
  const advertised = new Set(names);
  const off = new Set(options.off ?? []);
  return CONNECTED_REACH.map((row) =>
    off.has(row.id)
      ? { id: row.id, available: false, off: true as const }
      : { id: row.id, available: row.needs.every((group) => group.some((name) => advertised.has(name))) },
  );
}

const IDS = new Set<string>(CONNECTED_REACH.map((row) => row.id));
/** Reads a reach reply defensively: known ids with a boolean, each at most once. */
export function parseReach(value: unknown): ReachCheck[] | null {
  if (!Array.isArray(value) || value.length > CONNECTED_REACH.length) return null;
  const seen = new Set<string>();
  const out: ReachCheck[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const { id, available, off } = entry as { id?: unknown; available?: unknown; off?: unknown };
    if (typeof id !== "string" || !IDS.has(id) || seen.has(id) || typeof available !== "boolean") return null;
    if (off !== undefined && off !== true) return null;
    seen.add(id);
    out.push(off ? { id: id as ConnectedReachId, available: false, off: true } : { id: id as ConnectedReachId, available });
  }
  return out;
}
