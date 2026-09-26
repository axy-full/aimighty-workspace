/**
 * What Atomik can reach through the owner's connected account, as rows with a
 * live status (Atomik › Tools & connections).
 *
 * Each row names the tools that Particl's own code calls for that capability
 * — the same fixed names the toolset guard checks before any spend — grouped
 * as "every group must be advertised, any tool in a group will do". The live
 * check is the connection's own `tools/list` (free, read-only): a row is
 * available when every group has an advertised tool, missing otherwise.
 *
 * Only capability ids and statuses leave the server; the account's tool
 * names, descriptions and schemas never reach the browser, and nothing from
 * the account's library (characters, media, generations) is read here.
 *
 * Pure (no network, no database) so the browser and the server share it.
 * tests/unit/toolsConnections.spec.ts keeps the names in step with the
 * constants the workflows actually call.
 */
export type ConnectedReachId =
  | "models" | "image" | "video" | "audio" | "3d" | "batch" | "presets"
  | "files" | "follow" | "recipes" | "voice" | "marketing" | "shorts";

export type ConnectedReach = {
  id: ConnectedReachId;
  label: string;
  line: string;
  /** Every group must be advertised; any one tool in a group satisfies it. */
  needs: readonly (readonly string[])[];
};

export const CONNECTED_REACH: readonly ConnectedReach[] = Object.freeze([
  { id: "models", label: "Connected models", line: "Any model the account lists can be proposed", needs: [["models_explore"]] },
  { id: "image", label: "Images", line: "Stills on connected image models", needs: [["generate_image"]] },
  { id: "video", label: "Video", line: "Takes on connected video models", needs: [["generate_video"]] },
  { id: "audio", label: "Audio", line: "Voice, music and sound on connected models", needs: [["generate_audio"]] },
  { id: "3d", label: "3D", line: "Objects from a prompt or a still", needs: [["generate_3d"]] },
  { id: "batch", label: "Batches", line: "Several takes, one approval", needs: [["generate_image_batch", "generate_video_batch", "generate_audio_batch"]] },
  { id: "presets", label: "Motion presets", line: "Animate a still with a named move", needs: [["presets_show"]] },
  { id: "files", label: "Your files as references", line: "Attachments travel with the take", needs: [["media_import_url"]] },
  { id: "follow", label: "Follow every run", line: "Status until the file is in the project", needs: [["job_status", "jobs_wait", "job_display"]] },
  { id: "recipes", label: "Recipes", line: "/name plans from a workflow guide", needs: [["get_workflow_instructions"], ["get_workflow_bundle_file"]] },
  { id: "voice", label: "Voice change, dub, reframe", line: "On a project video, priced first", needs: [["voice_change", "dubbing", "reframe"]] },
  { id: "marketing", label: "Marketing templates", line: "Branded ads from a template", needs: [["marketing_studio_v2_presets"], ["marketing_studio_v2_costs"], ["marketing_studio_v2_create"], ["marketing_studio_v2_status"]] },
  { id: "shorts", label: "Shorts", line: "Clips cut from a long video", needs: [["shorts_studio_list_presets"], ["shorts_studio_create"], ["shorts_studio_status"]] },
] as const satisfies readonly ConnectedReach[]);

export type ReachCheck = { id: ConnectedReachId; available: boolean };

/** Every connected row against the advertised tool names of one connection. */
export function reachFromTools(names: Iterable<string>): ReachCheck[] {
  const advertised = new Set(names);
  return CONNECTED_REACH.map((row) => ({
    id: row.id,
    available: row.needs.every((group) => group.some((name) => advertised.has(name))),
  }));
}

const IDS = new Set<string>(CONNECTED_REACH.map((row) => row.id));
/** Reads a reach reply defensively: known ids with a boolean, each at most once. */
export function parseReach(value: unknown): ReachCheck[] | null {
  if (!Array.isArray(value) || value.length > CONNECTED_REACH.length) return null;
  const seen = new Set<string>();
  const out: ReachCheck[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const { id, available } = entry as { id?: unknown; available?: unknown };
    if (typeof id !== "string" || !IDS.has(id) || seen.has(id) || typeof available !== "boolean") return null;
    seen.add(id);
    out.push({ id: id as ConnectedReachId, available });
  }
  return out;
}
